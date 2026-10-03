import { describe, expect, it } from "vitest";
import {
  BOARD_HEIGHT,
  BOARD_WIDTH,
  MAX_BATCH_ENTRIES,
  MAX_MESSAGE_BYTES,
  MAX_SERVER_MESSAGE_BYTES,
  NOTE_MAX_H,
  NOTE_MAX_W,
  PROTOCOL_VERSION,
  checkBatch,
  clientMessageSchema,
  encodeMessage,
  noteBatchEntrySchema,
  parseMessage,
  serverMessageSchema,
  type NoteBatchEntry,
} from "../src/index";

/*
 * Protocol v7 (slice 2.8): one noteBatch message moves, resizes or deletes many notes. The
 * envelope is strict; each entry is checked on its own (checkBatch), so one bad entry is
 * reported by its index instead of refusing the batch. Fixtures are generic.
 */

const id = (i: number) => `note${String(i).padStart(12, "0")}`;
const move = (i: number, x = 10, y = 20): NoteBatchEntry => ({ op: "move", id: id(i), x, y });
const batch = (ops: unknown[], final = true) => ({ type: "noteBatch", ops, final });
const parses = (message: unknown) => clientMessageSchema.safeParse(message).success;

describe("protocol v7 batch constants", () => {
  it("is protocol 7, with at most 50 entries a batch", () => {
    expect(PROTOCOL_VERSION).toBe(7);
    expect(MAX_BATCH_ENTRIES).toBe(50);
  });

  it("the largest valid batch fits the existing 4 KiB client message cap (no raise needed)", () => {
    const ops: NoteBatchEntry[] = Array.from({ length: MAX_BATCH_ENTRIES }, (_, i) => ({
      op: "resize",
      id: id(i),
      x: BOARD_WIDTH - NOTE_MAX_W,
      y: BOARD_HEIGHT - NOTE_MAX_H,
      w: NOTE_MAX_W,
      h: NOTE_MAX_H,
    }));
    const raw = encodeMessage(batch(ops, false) as Parameters<typeof encodeMessage>[0]);
    expect(MAX_MESSAGE_BYTES).toBe(4096);
    expect(raw.length).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
    expect(parseMessage(raw, clientMessageSchema).ok).toBe(true);
  });

  it("the largest notesBatchApplied fits the server message cap", () => {
    const results = Array.from({ length: MAX_BATCH_ENTRIES }, (_, i) => ({
      type: "noteResized",
      id: id(i),
      x: BOARD_WIDTH - NOTE_MAX_W,
      y: BOARD_HEIGHT - NOTE_MAX_H,
      w: NOTE_MAX_W,
      h: NOTE_MAX_H,
      rev: Number.MAX_SAFE_INTEGER,
      final: true,
    }));
    const raw = JSON.stringify({ type: "notesBatchApplied", results, final: true });
    expect(raw.length).toBeLessThan(MAX_SERVER_MESSAGE_BYTES);
    expect(parseMessage(raw, serverMessageSchema, MAX_SERVER_MESSAGE_BYTES).ok).toBe(true);
  });
});

describe("noteBatch envelope", () => {
  it("accepts move, resize and delete entries together, final or not", () => {
    const ops = [move(1), { op: "resize", id: id(2), x: 0, y: 0, w: 200, h: 150 }, { op: "delete", id: id(3) }];
    expect(parses(batch(ops, true))).toBe(true);
    expect(parses(batch(ops, false))).toBe(true);
  });

  it("refuses an empty batch, more than 50 entries, a missing final, and extra keys (strict)", () => {
    expect(parses(batch([]))).toBe(false);
    expect(parses(batch(Array.from({ length: MAX_BATCH_ENTRIES + 1 }, (_, i) => move(i))))).toBe(false);
    expect(parses(batch(Array.from({ length: MAX_BATCH_ENTRIES }, (_, i) => move(i))))).toBe(true);
    expect(parses({ type: "noteBatch", ops: [move(1)] })).toBe(false);
    expect(parses({ ...batch([move(1)]), rev: 3 })).toBe(false);
    expect(parses({ type: "noteBatch", ops: "move", final: true })).toBe(false);
  });
});

describe("batch entries", () => {
  it.each([
    ["a move", move(1)],
    ["a resize", { op: "resize", id: id(1), x: 5, y: 6, w: 96, h: 480 }],
    ["a delete", { op: "delete", id: id(1) }],
  ])("accepts %s", (_label, entry) => {
    expect(noteBatchEntrySchema.safeParse(entry).success).toBe(true);
  });

  it.each([
    ["an unknown op", { op: "style", id: id(1), color: "red" }],
    ["a move with a size (strict)", { op: "move", id: id(1), x: 1, y: 1, w: 200 }],
    ["a delete with a position (strict)", { op: "delete", id: id(1), x: 1 }],
    ["a claimed rev", { op: "move", id: id(1), x: 1, y: 1, rev: 9 }],
    ["a bad id", { op: "move", id: "nope", x: 1, y: 1 }],
    ["an off-board x", { op: "move", id: id(1), x: BOARD_WIDTH + 1, y: 1 }],
    ["a negative y", { op: "move", id: id(1), x: 1, y: -1 }],
    ["a fractional x", { op: "move", id: id(1), x: 1.5, y: 1 }],
    ["a too-small width", { op: "resize", id: id(1), x: 1, y: 1, w: 10, h: 200 }],
    ["a missing height", { op: "resize", id: id(1), x: 1, y: 1, w: 200 }],
    ["a string", "move"],
    ["null", null],
  ])("refuses %s", (_label, entry) => {
    expect(noteBatchEntrySchema.safeParse(entry).success).toBe(false);
  });
});

describe("checkBatch (partial failure)", () => {
  it("returns the valid entries with their index, and the indexes of invalid ones", () => {
    const result = checkBatch([move(1), { op: "move", id: id(2), x: -5, y: 0 }, { op: "delete", id: id(3) }, "junk"]);
    expect(result.duplicate).toBe(false);
    expect(result.valid).toEqual([
      { index: 0, entry: move(1) },
      { index: 2, entry: { op: "delete", id: id(3) } },
    ]);
    expect(result.invalid).toEqual([1, 3]);
    // An invalid entry with a readable id still names it, so the sender can roll that note back.
    expect(result.invalidIds).toEqual([id(2)]);
  });

  it("a batch naming the same note twice is refused whole: every entry is invalid", () => {
    const result = checkBatch([move(1), move(2), { op: "delete", id: id(1) }]);
    expect(result.duplicate).toBe(true);
    expect(result.valid).toEqual([]);
    expect(result.invalid).toEqual([0, 1, 2]);
    expect(result.invalidIds).toEqual([id(1), id(2)]);
  });

  it("an all-valid batch has no invalid entries", () => {
    const ops = Array.from({ length: MAX_BATCH_ENTRIES }, (_, i) => move(i));
    const result = checkBatch(ops);
    expect(result.invalid).toEqual([]);
    expect(result.valid).toHaveLength(MAX_BATCH_ENTRIES);
  });
});

describe("server batch messages", () => {
  const moved = { type: "noteMoved", id: id(1), x: 1, y: 2, rev: 3, final: true };
  const resized = { type: "noteResized", id: id(2), x: 1, y: 2, w: 200, h: 200, rev: 4, final: true };
  const deleted = { type: "noteDeleted", id: id(3) };

  it("notesBatchApplied carries per-note results shaped like noteMoved, noteResized and noteDeleted", () => {
    expect(serverMessageSchema.safeParse({ type: "notesBatchApplied", results: [moved, resized, deleted], final: true }).success).toBe(true);
    expect(serverMessageSchema.safeParse({ type: "notesBatchApplied", results: [{ ...moved, final: false }], final: false }).success).toBe(true);
  });

  it("refuses an empty or oversized result list, and anything else in it", () => {
    expect(serverMessageSchema.safeParse({ type: "notesBatchApplied", results: [], final: true }).success).toBe(false);
    const many = Array.from({ length: MAX_BATCH_ENTRIES + 1 }, () => moved);
    expect(serverMessageSchema.safeParse({ type: "notesBatchApplied", results: many, final: true }).success).toBe(false);
    expect(serverMessageSchema.safeParse({ type: "notesBatchApplied", results: [{ type: "echo", from: id(1), text: "x" }], final: true }).success).toBe(false);
  });

  it("an error may name the refused entries by index and their note ids", () => {
    const err = { type: "error", code: "bad_message", message: "x", entries: [1, 3], noteIds: [id(2)] };
    expect(serverMessageSchema.safeParse(err).success).toBe(true);
    expect(serverMessageSchema.safeParse({ ...err, entries: [MAX_BATCH_ENTRIES] }).success).toBe(false);
    expect(serverMessageSchema.safeParse({ ...err, noteIds: ["bad"] }).success).toBe(false);
  });
});
