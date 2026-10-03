import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { BOARD_WIDTH, MAX_BATCH_ENTRIES, NOTE_MAX_W, PROTOCOL_VERSION, type ServerMessage } from "@stickyard/shared";
import { BATCH_LIMITS, SOCKET_LIMITS } from "../src/limits";
import type { Room } from "../src/room";
import { TestClient, nextOfType, specRoomCode } from "./helpers";

/*
 * Protocol v7 (slice 2.8): noteBatch. Final batches are applied in one SQLite transaction with
 * one broadcast; non-final ones are relayed to the others, coalesced, never stored. Invalid
 * entries are reported by index; unknown ids are ignored. Generic fixtures.
 */

const id = (i: number) => `seed${String(i).padStart(12, "0")}`;

/** A room seeded with `n` notes at (i*10, i*5), and two joined clients. */
async function room(n = 3) {
  const { code, id: roomId } = await specRoomCode();
  const stub = env.ROOM.get(env.ROOM.idFromName(roomId));
  await runInDurableObject(stub, (_room, state) => {
    for (let i = 0; i < n; i++) {
      state.storage.sql.exec(
        "INSERT INTO notes (id, x, y, text, color, rev, author_id) VALUES (?, ?, ?, 'Idea one', 'yellow', 1, 'AAAAAAAAAAAAAAAA')",
        id(i),
        i * 10,
        i * 5,
      );
    }
  });
  const a = await TestClient.open(code);
  const b = await TestClient.open(code);
  await a.enter("Alex");
  await b.enter("Sam");
  await nextOfType(a, "participant_joined");
  return { stub, a, b };
}

const rowsWritten = (stub: DurableObjectStub<Room>) => runInDurableObject(stub, (r: Room) => r.rowsWritten);
const transactions = (stub: DurableObjectStub<Room>) => runInDurableObject(stub, (r: Room) => r.transactions);
const stored = (stub: DurableObjectStub<Room>) =>
  runInDurableObject(stub, (_r, state) =>
    state.storage.sql.exec<{ id: string; x: number; y: number; w: number; h: number; rev: number }>("SELECT id, x, y, w, h, rev FROM notes ORDER BY rowid").toArray(),
  );
const close = (...cs: TestClient[]) => cs.forEach((c) => c.close());

describe("final batches", () => {
  it("move several notes in one transaction, one row write each, one broadcast to everyone, rev per note", async () => {
    const { stub, a, b } = await room(3);
    const writes = await rowsWritten(stub);
    const tx = await transactions(stub);
    a.send({
      type: "noteBatch",
      final: true,
      ops: [
        { op: "move", id: id(0), x: 500, y: 600 },
        { op: "move", id: id(1), x: 510, y: 610 },
        { op: "move", id: id(2), x: 520, y: 620 },
      ],
    });
    const expected = {
      type: "notesBatchApplied",
      final: true,
      results: [
        { type: "noteMoved", id: id(0), x: 500, y: 600, rev: 2, final: true },
        { type: "noteMoved", id: id(1), x: 510, y: 610, rev: 2, final: true },
        { type: "noteMoved", id: id(2), x: 520, y: 620, rev: 2, final: true },
      ],
    };
    expect(await nextOfType(a, "notesBatchApplied")).toEqual(expected);
    expect(await nextOfType(b, "notesBatchApplied")).toEqual(expected);
    expect(await b.quiet()).toBe(true);
    expect(await rowsWritten(stub)).toBe(writes + 3);
    expect(await transactions(stub)).toBe(tx + 1);
    expect((await stored(stub)).map((r) => [r.x, r.y, r.rev])).toEqual([
      [500, 600, 2],
      [510, 610, 2],
      [520, 620, 2],
    ]);
    close(a, b);
  });

  it("resizes are clamped per note (size, then position) and deletes remove the note", async () => {
    const { stub, a, b } = await room(3);
    a.send({
      type: "noteBatch",
      final: true,
      ops: [
        { op: "resize", id: id(0), x: BOARD_WIDTH - 100, y: 0, w: NOTE_MAX_W, h: 200 },
        { op: "delete", id: id(1) },
      ],
    });
    const applied = await nextOfType(b, "notesBatchApplied");
    expect(applied.results).toEqual([
      { type: "noteResized", id: id(0), x: BOARD_WIDTH - NOTE_MAX_W, y: 0, w: NOTE_MAX_W, h: 200, rev: 2, final: true },
      { type: "noteDeleted", id: id(1) },
    ]);
    expect((await stored(stub)).map((r) => r.id)).toEqual([id(0), id(2)]);
    close(a, b);
  });

  it("an unchanged move writes nothing but is still reported; unknown and deleted notes are ignored silently", async () => {
    const { stub, a, b } = await room(2);
    a.send({ type: "noteDelete", id: id(1) });
    await nextOfType(b, "noteDeleted");
    const writes = await rowsWritten(stub);
    a.send({
      type: "noteBatch",
      final: true,
      ops: [
        { op: "move", id: id(0), x: 0, y: 0 },
        { op: "move", id: id(1), x: 50, y: 50 },
        { op: "delete", id: id(1) },
        { op: "move", id: "unknownunknown00", x: 50, y: 50 },
      ],
    });
    const applied = await nextOfType(b, "notesBatchApplied");
    expect(applied.results).toEqual([{ type: "noteMoved", id: id(0), x: 0, y: 0, rev: 1, final: true }]);
    expect(await rowsWritten(stub)).toBe(writes);
    // Nothing known at all: nothing is sent.
    a.send({ type: "noteBatch", final: true, ops: [{ op: "move", id: id(1), x: 9, y: 9 }] });
    expect(await b.quiet()).toBe(true);
    expect(await a.quiet()).toBe(true);
    close(a, b);
  });

  it("partial failure: valid entries apply, invalid ones come back by index (and id) to the sender only", async () => {
    const { stub, a, b } = await room(3);
    a.send({
      type: "noteBatch",
      final: true,
      ops: [
        { op: "move", id: id(0), x: 100, y: 100 },
        { op: "move", id: id(1), x: -1, y: 100 },
        { op: "move", id: id(2), x: 300, y: 300, rev: 99 },
      ],
    });
    const messages: ServerMessage[] = [await a.next(), await a.next()];
    const error = messages.find((m) => m.type === "error");
    const applied = messages.find((m) => m.type === "notesBatchApplied");
    expect(error).toMatchObject({ code: "bad_message", entries: [1, 2], noteIds: [id(1), id(2)] });
    expect(applied).toMatchObject({ results: [{ type: "noteMoved", id: id(0), x: 100, y: 100, rev: 2 }] });
    expect((await nextOfType(b, "notesBatchApplied")).results).toHaveLength(1);
    expect(await b.quiet()).toBe(true);
    expect((await stored(stub)).map((r) => r.rev)).toEqual([2, 1, 1]);
    close(a, b);
  });

  it("a batch naming a note twice is refused whole, and nothing is written", async () => {
    const { stub, a, b } = await room(2);
    const writes = await rowsWritten(stub);
    a.send({
      type: "noteBatch",
      final: true,
      ops: [
        { op: "move", id: id(0), x: 100, y: 100 },
        { op: "move", id: id(1), x: 100, y: 100 },
        { op: "delete", id: id(0) },
      ],
    });
    expect(await nextOfType(a, "error")).toMatchObject({ code: "bad_message", entries: [0, 1, 2], noteIds: [id(0), id(1)] });
    expect(await b.quiet()).toBe(true);
    expect(await rowsWritten(stub)).toBe(writes);
    close(a, b);
  });

  it("before join gets not_joined naming the notes", async () => {
    const { code } = await specRoomCode();
    const c = await TestClient.open(code);
    await c.request({ type: "hello", protocolVersion: PROTOCOL_VERSION });
    const reply = await c.request({ type: "noteBatch", final: true, ops: [{ op: "delete", id: id(0) }] });
    expect(reply).toMatchObject({ type: "error", code: "not_joined", noteIds: [id(0)] });
    c.close();
  });
});

describe("non-final batches (a group drag)", () => {
  it("go to the others only, at the current rev, coalesced per note, and are never stored", async () => {
    const { stub, a, b } = await room(2);
    const writes = await rowsWritten(stub);
    for (let i = 1; i <= 10; i++) {
      a.send({
        type: "noteBatch",
        final: false,
        ops: [
          { op: "move", id: id(0), x: 100 + i, y: 100 },
          { op: "resize", id: id(1), x: 200 + i, y: 100, w: 200, h: 200 },
        ],
      });
    }
    const seen: number[] = [];
    for (;;) {
      const m = await nextOfType(b, "notesBatchApplied");
      expect(m.final).toBe(false);
      const first = m.results.find((r) => r.type === "noteMoved" && r.id === id(0));
      if (first && first.type === "noteMoved") {
        expect(first).toMatchObject({ rev: 1, final: false });
        seen.push(first.x);
        if (first.x === 110) break;
      }
    }
    expect(seen).toEqual([...seen].sort((p, q) => p - q));
    expect(seen.length).toBeLessThanOrEqual(10);
    expect(await a.quiet()).toBe(true);
    expect(await rowsWritten(stub)).toBe(writes);
    close(a, b);
  });

  it("a deleted note's pending drag is not relayed", async () => {
    const { a, b } = await room(2);
    a.send({ type: "noteBatch", final: false, ops: [{ op: "move", id: id(0), x: 300, y: 300 }] });
    a.send({ type: "noteDelete", id: id(0) });
    const first = await b.next();
    // The relay flushes before the delete; either way nothing moves after it.
    if (first.type === "notesBatchApplied") expect(await nextOfType(b, "noteDeleted")).toMatchObject({ id: id(0) });
    else expect(first).toMatchObject({ type: "noteDeleted", id: id(0) });
    expect(await b.quiet()).toBe(true);
    close(a, b);
  });
});

describe("rate budget", () => {
  it("a batch counts as one message: 30 batches of 30 entries are all relayed", async () => {
    expect(30).toBeLessThan(SOCKET_LIMITS.burst);
    expect(30 * 30).toBeLessThanOrEqual(BATCH_LIMITS.entriesBurst);
    const { a, b } = await room(30);
    for (let n = 0; n < 30; n++) {
      a.send({ type: "noteBatch", final: false, ops: Array.from({ length: 30 }, (_, i) => ({ op: "move", id: id(i), x: 100 + n, y: i })) });
    }
    // The last position arrives; nothing was refused.
    for (;;) {
      const m = await nextOfType(b, "notesBatchApplied");
      const r = m.results.find((x) => x.type === "noteMoved" && x.id === id(29));
      if (r && r.type === "noteMoved" && r.x === 129) break;
    }
    expect(await a.quiet()).toBe(true);
    close(a, b);
  });

  it("entries also feed a per-socket entries budget: too many are dropped with rate_limited naming the notes", async () => {
    expect(BATCH_LIMITS.entriesBurst).toBeLessThan(30 * MAX_BATCH_ENTRIES);
    const { a, b } = await room(MAX_BATCH_ENTRIES);
    const ops = (n: number) => Array.from({ length: MAX_BATCH_ENTRIES }, (_, i) => ({ op: "move", id: id(i), x: 100 + n, y: i }));
    // Within the message budget (30 < burst), over the entries budget (1500 > burst).
    for (let n = 0; n < 30; n++) a.send({ type: "noteBatch", final: false, ops: ops(n) });
    const error = await nextOfType(a, "error");
    expect(error).toMatchObject({ code: "rate_limited" });
    expect(error.noteIds).toHaveLength(MAX_BATCH_ENTRIES);
    expect(a.closeCode).toBeNull();
    close(a, b);
  });

  it("limits are sized for a 50-note group drag", () => {
    // The web sends a live group drag at most every 100 ms: 500 entries a second.
    expect(BATCH_LIMITS.entriesPerSecond).toBeGreaterThanOrEqual(500);
    expect(BATCH_LIMITS.entriesBurst).toBeGreaterThanOrEqual(4 * MAX_BATCH_ENTRIES);
  });
});
