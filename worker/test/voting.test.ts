/// <reference types="vite/client" />
import { env, evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { MAX_MESSAGE_BYTES, MAX_VOTERS_PER_ROUND, PROTOCOL_VERSION, VOTE_BUDGET_DEFAULT, VOTE_BUDGET_MAX, type ServerMessage } from "@stickyard/shared";
import { hostTokenFor } from "../src/hostToken";
import type { Room } from "../src/room";
import { NoteStore, SCHEMA_VERSION } from "../src/noteStore";
import { voterIdFor } from "../src/voterId";
import { V5_NOTES } from "./fixtures/schemaV5";
import { V6_FRAMES } from "./fixtures/schemaV6";
import { V7_NOTE_DELETE, V7_NOTE_INSERT, loadSchemaV7 } from "./fixtures/schemaV7";
import { TEST_SIGNING_KEY, TestClient, nextOfType, specHostToken, specRoomCode } from "./helpers";

/*
 * Protocol v13 (dot voting, relay and plumbing): claimVoter / voterGranted, the voting state on
 * joined, voteStart / voteStop / voteClear (host only), voteSet / voteConfirmed and votesRevealed.
 * Votes are anonymous: the relay stores them against an HMAC of the client's random key, never the
 * key, and no message says who voted for what. Fake keys only (vitest.config.ts).
 */

const voterSources = import.meta.glob<string>("../src/voterId.ts", { query: "?raw", import: "default", eager: true });

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
/** A fresh voter key as the web makes one: 128 random bits, base64url (22 characters). */
const newKey = () => b64url(crypto.getRandomValues(new Uint8Array(16)));

/** The voter id straight from the spec, independently of src/voterId.ts. */
async function specVoterId(roomId: string, key: string, signingKey = TEST_SIGNING_KEY): Promise<string> {
  const hmacKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(signingKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", hmacKey, new TextEncoder().encode(`stickyard-voter-v1:${roomId}:${key}`))));
}

async function newRoom() {
  const { code, id } = await specRoomCode();
  return { code, id, token: await specHostToken(id), stub: env.ROOM.get(env.ROOM.idFromName(id)) };
}

const rowsWritten = (stub: DurableObjectStub<Room>) => runInDurableObject(stub, (r: Room) => r.rowsWritten);
type Row = Record<string, SqlStorageValue>;
const allRows = (stub: DurableObjectStub<Room>) =>
  runInDurableObject(stub, (_r, state) => {
    const tables = state.storage.sql
      .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'")
      .toArray()
      .map((t) => t.name);
    const rows: Record<string, Row[]> = {};
    for (const t of tables) rows[t] = state.storage.sql.exec<Row>(`SELECT * FROM ${t}`).toArray();
    return rows;
  });
const voteRows = async (stub: DurableObjectStub<Room>) => (await allRows(stub)).votes ?? [];
const meta = async (stub: DurableObjectStub<Room>) => Object.fromEntries(((await allRows(stub)).meta ?? []).map((r) => [String(r.key), Number(r.value)]));
const attachments = (stub: DurableObjectStub<Room>) => runInDurableObject(stub, (_r, state) => state.getWebSockets().map((ws) => ws.deserializeAttachment() as unknown));
const closeAll = (...cs: TestClient[]) => cs.forEach((c) => c.close());
const settle = () => new Promise((r) => setTimeout(r, 50));
/** Reads and drops whatever a client has been sent (joins and leaves of other sockets) until it is quiet. */
async function drain(...cs: TestClient[]) {
  for (const c of cs) while (!(await c.quiet(60))) await c.next(1).catch(() => undefined);
}

/** Every raw message a client receives, from the moment it opens. */
function recorded(c: TestClient): string[] {
  const raw: string[] = [];
  c.ws.addEventListener("message", (e) => raw.push(String(e.data)));
  return raw;
}

async function addNote(c: TestClient, ref: string, others: TestClient[] = []) {
  c.send({ type: "noteAdd", clientRef: ref, x: 10, y: 10, color: "yellow", text: ref });
  const note = (await nextOfType(c, "noteAdded")).note;
  for (const o of others) await nextOfType(o, "noteAdded");
  return note;
}

/** A room with a host (Alex, claimed) and a guest (Sam), and three notes by Alex. */
async function votingRoom() {
  const room = await newRoom();
  const host = await TestClient.open(room.code);
  const guest = await TestClient.open(room.code);
  await host.enter("Alex");
  await guest.enter("Sam");
  await nextOfType(host, "participant_joined");
  expect(await host.request({ type: "claimHost", token: room.token })).toEqual({ type: "hostGranted" });
  await nextOfType(guest, "participantUpdated");
  const notes = [await addNote(host, "n1", [guest]), await addNote(host, "n2", [guest]), await addNote(host, "n3", [guest])];
  return { ...room, host, guest, notes };
}

async function start(host: TestClient, others: TestClient[], budget = VOTE_BUDGET_DEFAULT) {
  const changed = await host.request({ type: "voteStart", budget });
  expect(changed).toMatchObject({ type: "votingChanged", voting: { state: "open", budget } });
  for (const o of others) expect(await nextOfType(o, "votingChanged")).toEqual(changed);
  return (changed as Extract<ServerMessage, { type: "votingChanged" }>).voting;
}

async function claim(c: TestClient, key: string) {
  await drain(c);
  const granted = await c.request({ type: "claimVoter", key });
  expect(granted.type).toBe("voterGranted");
  return granted as Extract<ServerMessage, { type: "voterGranted" }>;
}

describe("voter id", () => {
  it("is the full HMAC of room id and key under its own domain, 43 characters", async () => {
    const { id } = await specRoomCode();
    const key = newKey();
    const voterId = await voterIdFor(id, key, TEST_SIGNING_KEY);
    expect(voterId).toBe(await specVoterId(id, key));
    expect(voterId).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("is domain-separated from the host token, and differs per room, per key and per signing key", async () => {
    const a = await specRoomCode();
    const b = await specRoomCode();
    const key = newKey();
    const voterId = await voterIdFor(a.id, key, TEST_SIGNING_KEY);
    expect(voterId).not.toBe(await hostTokenFor(a.id, TEST_SIGNING_KEY));
    expect(voterId).not.toBe(await hostTokenFor(`${a.id}:${key}`, TEST_SIGNING_KEY));
    expect(await voterIdFor(b.id, key, TEST_SIGNING_KEY)).not.toBe(voterId);
    expect(await voterIdFor(a.id, newKey(), TEST_SIGNING_KEY)).not.toBe(voterId);
    expect(await voterIdFor(a.id, key, "another-fake-key")).not.toBe(voterId);
  });

  it("can't be made without a signing key or a room id (fails closed)", async () => {
    expect(await voterIdFor("room", newKey(), "")).toBeNull();
    expect(await voterIdFor("", newKey(), TEST_SIGNING_KEY)).toBeNull();
  });

  it("the module only derives: it keeps nothing and logs nothing", () => {
    const text = Object.values(voterSources)[0] ?? "";
    expect(text).toContain("hmacSha256(");
    expect(text).not.toMatch(/\bconsole\b|\bstorage\b|\bsql\b/);
  });
});

describe("claimVoter", () => {
  it("needs a join first", async () => {
    const { code } = await newRoom();
    const c = await TestClient.open(code);
    await c.request({ type: "hello", protocolVersion: PROTOCOL_VERSION });
    expect(await c.request({ type: "claimVoter", key: newKey() })).toMatchObject({ type: "error", code: "not_joined" });
    c.close();
  });

  it("grants a voter with the full budget and nothing voted; writes nothing", async () => {
    const { host, guest, stub } = await votingRoom();
    const before = await rowsWritten(stub);
    expect(await guest.request({ type: "claimVoter", key: newKey() })).toEqual({ type: "voterGranted", remaining: VOTE_BUDGET_DEFAULT, mine: [] });
    expect(await rowsWritten(stub)).toBe(before);
    expect(await host.quiet()).toBe(true);
    closeAll(host, guest);
  });

  it("the same key from a second socket, a reconnect or after hibernation is the same voter", async () => {
    const { code, host, guest, stub, notes } = await votingRoom();
    await start(host, [guest]);
    const key = newKey();
    await claim(guest, key);
    expect(await guest.request({ type: "voteSet", noteId: notes[0]!.id, count: 2 })).toEqual({ type: "voteConfirmed", noteId: notes[0]!.id, count: 2, remaining: 3 });
    // A second tab.
    const tab = await TestClient.open(code);
    await tab.enter("Sam");
    expect(await claim(tab, key)).toEqual({ type: "voterGranted", remaining: 3, mine: [{ noteId: notes[0]!.id, count: 2 }] });
    // Both of the voter's sockets hear its confirmations.
    expect(await tab.request({ type: "voteSet", noteId: notes[1]!.id, count: 1 })).toMatchObject({ type: "voteConfirmed", remaining: 2 });
    expect(await nextOfType(guest, "voteConfirmed")).toEqual({ type: "voteConfirmed", noteId: notes[1]!.id, count: 1, remaining: 2 });
    // A reconnect: a new socket, a new participant, the same voter.
    guest.close();
    const again = await TestClient.open(code);
    await again.enter("Sam");
    expect(await claim(again, key)).toEqual({ type: "voterGranted", remaining: 2, mine: [{ noteId: notes[0]!.id, count: 2 }, { noteId: notes[1]!.id, count: 1 }] });
    // Hibernation: the voter id lives in the attachment, the votes in SQLite.
    await evictDurableObject(stub);
    expect(await again.request({ type: "voteSet", noteId: notes[2]!.id, count: 2 })).toEqual({ type: "voteConfirmed", noteId: notes[2]!.id, count: 2, remaining: 0 });
    expect(await nextOfType(tab, "voteConfirmed")).toMatchObject({ remaining: 0 });
    // A different key is a different voter.
    const other = await claim(host, newKey());
    expect(other).toEqual({ type: "voterGranted", remaining: VOTE_BUDGET_DEFAULT, mine: [] });
    closeAll(host, tab, again);
  });

  it("a malformed key or extra fields are bad_message (strict), and grant nothing", async () => {
    const { host, guest, notes } = await votingRoom();
    await start(host, [guest]);
    for (const m of [
      { type: "claimVoter", key: "short" },
      { type: "claimVoter", key: "k".repeat(65) },
      { type: "claimVoter", key: `${"k".repeat(21)}=` },
      { type: "claimVoter", key: newKey(), voterId: "x".repeat(43) },
    ]) {
      expect(await guest.request(m)).toMatchObject({ type: "error", code: "bad_message" });
    }
    expect(await guest.request({ type: "voteSet", noteId: notes[0]!.id, count: 1 })).toMatchObject({ type: "error", code: "no_voter", noteId: notes[0]!.id });
    closeAll(host, guest);
  });

  it("a key over the message cap is too_large", async () => {
    const { host, guest } = await votingRoom();
    expect(await guest.request({ type: "claimVoter", key: "k".repeat(MAX_MESSAGE_BYTES) })).toMatchObject({ type: "error", code: "too_large" });
    closeAll(host, guest);
  });

  it("no other field sets a voter: voteSet can't name one, and join fields are ignored", async () => {
    const { host, guest, notes } = await votingRoom();
    await start(host, [guest]);
    expect(await guest.request({ type: "voteSet", noteId: notes[0]!.id, count: 1, voterId: "x".repeat(43) })).toMatchObject({ code: "bad_message" });
    expect(await guest.request({ type: "voteSet", noteId: notes[0]!.id, count: 1 })).toMatchObject({ code: "no_voter" });
    closeAll(host, guest);
  });
});

describe("the raw key", () => {
  it("is never stored (tables or attachments) and never sent back; only its HMAC is stored", async () => {
    const { id, host, guest, stub, notes } = await votingRoom();
    const raw = [recorded(host), recorded(guest)];
    await start(host, [guest]);
    const keys = [newKey(), newKey()];
    await claim(host, keys[0]!);
    await claim(guest, keys[1]!);
    await host.request({ type: "voteSet", noteId: notes[0]!.id, count: 1 });
    await guest.request({ type: "voteSet", noteId: notes[0]!.id, count: 2 });
    const stored = JSON.stringify(await allRows(stub)) + JSON.stringify(await attachments(stub));
    for (const key of keys) {
      expect(stored).not.toContain(key);
      for (const r of raw) expect(r.join("\n")).not.toContain(key);
    }
    const ids = (await voteRows(stub)).map((r) => r.voter_id).sort();
    expect(ids).toEqual([await specVoterId(id, keys[0]!), await specVoterId(id, keys[1]!)].sort());
    closeAll(host, guest);
  });
});

describe("voting state", () => {
  it("joined carries it: off, budget 5, round 0 in a fresh room", async () => {
    const { code } = await newRoom();
    const c = await TestClient.open(code);
    expect((await c.enter("Alex")).voting).toEqual({ state: "off", budget: VOTE_BUDGET_DEFAULT, round: 0 });
    c.close();
  });

  it("voteStart, voteStop and voteClear are host-only: a guest gets not_host and nothing is written", async () => {
    const { host, guest, stub } = await votingRoom();
    await start(host, [guest]);
    const before = await rowsWritten(stub);
    for (const m of [{ type: "voteStart", budget: 3 }, { type: "voteStop" }, { type: "voteClear" }]) {
      expect(await guest.request(m)).toMatchObject({ type: "error", code: "not_host" });
    }
    expect(await rowsWritten(stub)).toBe(before);
    expect(await host.quiet()).toBe(true);
    closeAll(host, guest);
  });

  it("bad budgets are bad_message, not clamped, and write nothing", async () => {
    const { host, guest, stub } = await votingRoom();
    const before = await rowsWritten(stub);
    for (const budget of [0, VOTE_BUDGET_MAX + 1, 2.5, -3, "5", null]) {
      expect(await host.request({ type: "voteStart", budget })).toMatchObject({ type: "error", code: "bad_message" });
    }
    expect(await rowsWritten(stub)).toBe(before);
    expect(await guest.quiet()).toBe(true);
    expect(await host.request({ type: "voteStart", budget: VOTE_BUDGET_MAX })).toMatchObject({ voting: { budget: VOTE_BUDGET_MAX } });
    closeAll(host, guest);
  });

  it("voteStart opens a new round for everyone and persists across hibernation", async () => {
    const { code, host, guest, stub } = await votingRoom();
    expect(await start(host, [guest], 7)).toEqual({ state: "open", budget: 7, round: 1 });
    expect(await meta(stub)).toMatchObject({ voting_state: 1, voting_budget: 7, voting_round: 1 });
    closeAll(host, guest);
    await settle();
    await evictDurableObject(stub);
    const c = await TestClient.open(code);
    expect((await c.enter("Priya")).voting).toEqual({ state: "open", budget: 7, round: 1 });
    // Open: nothing about anyone's votes is sent to a joiner.
    expect(await c.quiet()).toBe(true);
    c.close();
  });

  it("voteStart clears the previous round's votes and bumps the round", async () => {
    const { host, guest, stub, notes } = await votingRoom();
    await start(host, [guest]);
    const key = newKey();
    await claim(guest, key);
    await guest.request({ type: "voteSet", noteId: notes[0]!.id, count: 3 });
    await guest.request({ type: "voteSet", noteId: notes[1]!.id, count: 2 });
    expect(await voteRows(stub)).toHaveLength(2);
    const before = await rowsWritten(stub);
    expect(await start(host, [guest], 3)).toEqual({ state: "open", budget: 3, round: 2 });
    // Two vote rows deleted (1 each), the budget stored for the first time (5 was the default: row
    // and index), the round changed (1); the state stays open (nothing).
    expect((await rowsWritten(stub)) - before).toBe(2 + 2 + 1);
    expect(await voteRows(stub)).toEqual([]);
    expect(await guest.request({ type: "claimVoter", key })).toEqual({ type: "voterGranted", remaining: 3, mine: [] });
    closeAll(host, guest);
  });

  it("voteStop closes it: everyone gets votingChanged, then votesRevealed with the non-zero totals; 1 row", async () => {
    const { host, guest, stub, notes } = await votingRoom();
    await start(host, [guest]);
    await claim(host, newKey());
    await claim(guest, newKey());
    await host.request({ type: "voteSet", noteId: notes[2]!.id, count: 2 });
    await host.request({ type: "voteSet", noteId: notes[0]!.id, count: 1 });
    await guest.request({ type: "voteSet", noteId: notes[2]!.id, count: 3 });
    const before = await rowsWritten(stub);
    host.send({ type: "voteStop" });
    for (const c of [host, guest]) {
      expect(await c.next()).toEqual({ type: "votingChanged", voting: { state: "closed", budget: VOTE_BUDGET_DEFAULT, round: 1 } });
      // In note creation order; notes without dots left out.
      expect(await c.next()).toEqual({ type: "votesRevealed", round: 1, totals: [{ noteId: notes[0]!.id, count: 1 }, { noteId: notes[2]!.id, count: 5 }] });
    }
    expect((await rowsWritten(stub)) - before).toBe(1);
    expect((await meta(stub)).voting_state).toBe(2);
    // Closed: no more votes, and stopping again writes nothing and tells only the sender.
    expect(await guest.request({ type: "voteSet", noteId: notes[1]!.id, count: 1 })).toMatchObject({ type: "error", code: "voting_closed", noteId: notes[1]!.id });
    const after = await rowsWritten(stub);
    expect(await host.request({ type: "voteStop" })).toMatchObject({ type: "votingChanged", voting: { state: "closed" } });
    expect(await host.next()).toMatchObject({ type: "votesRevealed" });
    expect(await guest.quiet()).toBe(true);
    expect(await rowsWritten(stub)).toBe(after);
    closeAll(host, guest);
  });

  it("voteClear deletes every vote and turns voting off for everyone", async () => {
    const { host, guest, stub, notes } = await votingRoom();
    await start(host, [guest]);
    await claim(guest, newKey());
    await guest.request({ type: "voteSet", noteId: notes[0]!.id, count: 2 });
    expect(await host.request({ type: "voteClear" })).toEqual({ type: "votingChanged", voting: { state: "off", budget: VOTE_BUDGET_DEFAULT, round: 1 } });
    expect(await nextOfType(guest, "votingChanged")).toMatchObject({ voting: { state: "off" } });
    expect(await voteRows(stub)).toEqual([]);
    expect((await meta(stub)).voting_state).toBe(0);
    expect(await guest.request({ type: "voteSet", noteId: notes[0]!.id, count: 1 })).toMatchObject({ code: "voting_closed" });
    // Clearing again changes nothing: only the sender hears, nothing is written.
    const before = await rowsWritten(stub);
    expect(await host.request({ type: "voteClear" })).toMatchObject({ voting: { state: "off" } });
    expect(await guest.quiet()).toBe(true);
    expect(await rowsWritten(stub)).toBe(before);
    closeAll(host, guest);
  });
});

describe("voteSet", () => {
  it("is refused while voting is off (voting_closed), and without a claim (no_voter)", async () => {
    const { host, guest, notes } = await votingRoom();
    await claim(guest, newKey());
    expect(await guest.request({ type: "voteSet", noteId: notes[0]!.id, count: 1 })).toMatchObject({ type: "error", code: "voting_closed", noteId: notes[0]!.id });
    await start(host, [guest]);
    expect(await host.request({ type: "voteSet", noteId: notes[0]!.id, count: 1 })).toMatchObject({ type: "error", code: "no_voter", noteId: notes[0]!.id });
    closeAll(host, guest);
  });

  it("budget: exactly at it is fine; one over across several notes is over_budget (with the note), nothing written", async () => {
    const { host, guest, stub, notes } = await votingRoom();
    await start(host, [guest]);
    await claim(guest, newKey());
    const [a, b, c] = notes.map((n) => n.id) as [string, string, string];
    expect(await guest.request({ type: "voteSet", noteId: a, count: 2 })).toMatchObject({ remaining: 3 });
    expect(await guest.request({ type: "voteSet", noteId: b, count: 3 })).toMatchObject({ remaining: 0 });
    const before = await rowsWritten(stub);
    expect(await guest.request({ type: "voteSet", noteId: c, count: 1 })).toMatchObject({ type: "error", code: "over_budget", noteId: c });
    expect(await guest.request({ type: "voteSet", noteId: a, count: 3 })).toMatchObject({ type: "error", code: "over_budget", noteId: a });
    expect(await guest.request({ type: "voteSet", noteId: c, count: VOTE_BUDGET_DEFAULT + 1 })).toMatchObject({ code: "over_budget", noteId: c });
    expect(await rowsWritten(stub)).toBe(before);
    // Moving a dot: lower one, then the other fits.
    expect(await guest.request({ type: "voteSet", noteId: a, count: 1 })).toEqual({ type: "voteConfirmed", noteId: a, count: 1, remaining: 1 });
    expect(await guest.request({ type: "voteSet", noteId: c, count: 1 })).toEqual({ type: "voteConfirmed", noteId: c, count: 1, remaining: 0 });
    closeAll(host, guest);
  });

  it("all dots on one note, and on your own note, are allowed", async () => {
    const { host, guest, notes } = await votingRoom();
    await start(host, [guest], VOTE_BUDGET_MAX);
    await claim(host, newKey());
    expect(await host.request({ type: "voteSet", noteId: notes[0]!.id, count: VOTE_BUDGET_MAX })).toEqual({ type: "voteConfirmed", noteId: notes[0]!.id, count: VOTE_BUDGET_MAX, remaining: 0 });
    closeAll(host, guest);
  });

  it("an unknown or deleted note is ignored silently, and writes nothing", async () => {
    const { host, guest, stub } = await votingRoom();
    await start(host, [guest]);
    await claim(guest, newKey());
    const before = await rowsWritten(stub);
    guest.send({ type: "voteSet", noteId: "nosuchnote000000", count: 1 });
    expect(await guest.quiet()).toBe(true);
    expect(await host.quiet()).toBe(true);
    expect(await rowsWritten(stub)).toBe(before);
    closeAll(host, guest);
  });

  it("row writes: a new vote 2 (row and index), a changed count 1, the same count 0 (still confirmed), back to 0 deletes (1)", async () => {
    const { host, guest, stub, notes } = await votingRoom();
    await start(host, [guest]);
    await claim(guest, newKey());
    const id = notes[0]!.id;
    const cost = async (count: number) => {
      const before = await rowsWritten(stub);
      expect(await guest.request({ type: "voteSet", noteId: id, count })).toMatchObject({ type: "voteConfirmed", noteId: id, count });
      return (await rowsWritten(stub)) - before;
    };
    expect(await cost(1)).toBe(2);
    expect(await cost(3)).toBe(1);
    expect(await cost(3)).toBe(0);
    expect(await cost(0)).toBe(1);
    expect(await cost(0)).toBe(0);
    expect(await voteRows(stub)).toEqual([]);
    closeAll(host, guest);
  });

  it("is anonymous while open: nobody else hears anything", async () => {
    const { host, guest, notes } = await votingRoom();
    await start(host, [guest]);
    await claim(guest, newKey());
    await guest.request({ type: "voteSet", noteId: notes[0]!.id, count: 2 });
    expect(await host.quiet()).toBe(true);
    closeAll(host, guest);
  });

  it("a locked board still takes votes and claims from guests", async () => {
    const { host, guest, notes } = await votingRoom();
    expect(await host.request({ type: "lockSet", locked: true })).toEqual({ type: "lockChanged", locked: true });
    await nextOfType(guest, "lockChanged");
    await start(host, [guest]);
    await claim(guest, newKey());
    expect(await guest.request({ type: "voteSet", noteId: notes[0]!.id, count: 1 })).toMatchObject({ type: "voteConfirmed", count: 1 });
    // The board itself stays locked.
    expect(await guest.request({ type: "noteDelete", id: notes[0]!.id })).toMatchObject({ code: "board_locked" });
    closeAll(host, guest);
  });

  it("is an ordinary message for the rate limit (rate_limited names the note)", async () => {
    const { host, guest, notes } = await votingRoom();
    await start(host, [guest], VOTE_BUDGET_MAX);
    await claim(guest, newKey());
    // Past the burst of 40, but far below the 20 violations that would close the socket.
    const sent = 45;
    for (let i = 0; i < sent; i++) guest.send({ type: "voteSet", noteId: notes[0]!.id, count: i % 2 });
    let refused: ServerMessage | null = null;
    for (let i = 0; i < sent && !refused; i++) {
      const m = await guest.next();
      if (m.type === "error") refused = m;
    }
    expect(refused).toMatchObject({ type: "error", code: "rate_limited", noteId: notes[0]!.id });
    closeAll(host, guest);
  });
});

describe("deleting notes refunds dots", () => {
  it("noteDelete and batch deletes remove the note's votes in the same transaction; nothing about votes is sent", async () => {
    const { code, host, guest, stub, notes } = await votingRoom();
    await start(host, [guest]);
    const key = newKey();
    await claim(guest, key);
    await guest.request({ type: "voteSet", noteId: notes[0]!.id, count: 2 });
    await guest.request({ type: "voteSet", noteId: notes[1]!.id, count: 2 });
    await guest.request({ type: "voteSet", noteId: notes[2]!.id, count: 1 });
    host.send({ type: "noteDelete", id: notes[0]!.id });
    expect(await guest.next()).toEqual({ type: "noteDeleted", id: notes[0]!.id });
    host.send({ type: "noteBatch", ops: [{ op: "delete", id: notes[1]!.id }], final: true });
    expect(await guest.next()).toMatchObject({ type: "notesBatchApplied" });
    expect(await guest.quiet()).toBe(true);
    expect((await voteRows(stub)).map((r) => r.note_id)).toEqual([notes[2]!.id]);
    // The dots are back: the next confirmation and a fresh claim say so.
    expect(await guest.request({ type: "voteSet", noteId: notes[2]!.id, count: 1 })).toMatchObject({ remaining: 4 });
    const tab = await TestClient.open(code);
    await tab.enter("Sam");
    expect(await claim(tab, key)).toEqual({ type: "voterGranted", remaining: 4, mine: [{ noteId: notes[2]!.id, count: 1 }] });
    closeAll(host, guest, tab);
  });
});

describe("results", () => {
  it("nobody's identity in any message: a multi-voter round, every message every socket got", async () => {
    const { id, code, host, guest, notes } = await votingRoom();
    const priya = await TestClient.open(code);
    const raw = new Map([
      [host, recorded(host)],
      [guest, recorded(guest)],
      [priya, recorded(priya)],
    ]);
    await priya.enter("Priya");
    await nextOfType(host, "participant_joined");
    await nextOfType(guest, "participant_joined");
    await start(host, [guest, priya]);
    const keys = new Map([
      [host, newKey()],
      [guest, newKey()],
      [priya, newKey()],
    ]);
    for (const [c, key] of keys) await claim(c, key);
    const plan: [TestClient, number, number][] = [
      [host, 0, 1],
      [guest, 0, 2],
      [guest, 1, 3],
      [priya, 2, 5],
      [priya, 2, 4],
    ];
    for (const [c, note, count] of plan) await c.request({ type: "voteSet", noteId: notes[note]!.id, count });
    // While open, voteConfirmed reached only the voter.
    for (const c of [host, guest, priya]) expect(await c.quiet()).toBe(true);
    host.send({ type: "voteStop" });
    for (const c of [host, guest, priya]) {
      await nextOfType(c, "votingChanged");
      expect(await c.next()).toEqual({
        type: "votesRevealed",
        round: 1,
        totals: [
          { noteId: notes[0]!.id, count: 3 },
          { noteId: notes[1]!.id, count: 3 },
          { noteId: notes[2]!.id, count: 4 },
        ],
      });
    }
    const secrets = [...keys.values(), ...(await Promise.all([...keys.values()].map((k) => specVoterId(id, k))))];
    for (const [c, messages] of raw) {
      const text = messages.join("\n");
      for (const s of secrets) expect(text).not.toContain(s);
      // Each socket heard only its own confirmations.
      const confirmed = messages.map((m) => JSON.parse(m) as ServerMessage).filter((m) => m.type === "voteConfirmed");
      expect(confirmed).toHaveLength(plan.filter(([who]) => who === c).length);
      // No message names a participant next to a note's votes.
      for (const m of messages.map((x) => JSON.parse(x) as ServerMessage)) {
        if (m.type === "votesRevealed" || m.type === "voteConfirmed" || m.type === "voterGranted" || m.type === "votingChanged") {
          expect(JSON.stringify(m)).not.toMatch(/"(from|authorId|participant|voter|voterId|id)"/);
        }
      }
    }
    closeAll(host, guest, priya);
  });

  it("a late joiner gets the totals right after the snapshots when closed; nothing when open or off", async () => {
    const { code, host, guest, notes } = await votingRoom();
    const off = await TestClient.open(code);
    await off.enter("Priya");
    expect(await off.quiet()).toBe(true);
    off.close();
    await off.waitClose();
    await settle();
    await drain(host, guest);
    await start(host, [guest]);
    await claim(guest, newKey());
    await guest.request({ type: "voteSet", noteId: notes[1]!.id, count: 2 });
    const open = await TestClient.open(code);
    expect((await open.enter("Priya")).voting.state).toBe("open");
    expect(await open.quiet()).toBe(true);
    open.close();
    await open.waitClose();
    await settle();
    host.send({ type: "voteStop" });
    await nextOfType(guest, "votesRevealed");
    const late = await TestClient.open(code);
    expect((await late.enter("Priya")).voting).toEqual({ state: "closed", budget: VOTE_BUDGET_DEFAULT, round: 1 });
    // The very next message, in the same handler step as the snapshots.
    expect(await late.next()).toEqual({ type: "votesRevealed", round: 1, totals: [{ noteId: notes[1]!.id, count: 2 }] });
    closeAll(host, guest, late);
  });
});

describe("voters cap", () => {
  it(`${MAX_VOTERS_PER_ROUND} voters a round: one more is voters_full; known voters still get in; a new round makes room`, async () => {
    const { code, host, guest, notes } = await votingRoom();
    await start(host, [guest], 1);
    const keys = Array.from({ length: MAX_VOTERS_PER_ROUND }, newKey);
    for (const key of keys) {
      const c = await TestClient.open(code);
      await c.enter("Voter");
      await claim(c, key);
      expect(await c.request({ type: "voteSet", noteId: notes[0]!.id, count: 1 })).toMatchObject({ type: "voteConfirmed" });
      c.close();
      await c.waitClose();
    }
    await drain(host, guest);
    expect(await guest.request({ type: "claimVoter", key: newKey() })).toMatchObject({ type: "error", code: "voters_full" });
    expect(await claim(guest, keys[7]!)).toEqual({ type: "voterGranted", remaining: 0, mine: [{ noteId: notes[0]!.id, count: 1 }] });
    await start(host, [guest]);
    expect(await claim(host, newKey())).toMatchObject({ remaining: VOTE_BUDGET_DEFAULT });
    closeAll(host, guest);
  });
});

describe("burial", () => {
  it("End session drops the votes table with everything else; the tombstone stays", async () => {
    const { host, guest, stub, notes } = await votingRoom();
    await start(host, [guest]);
    await claim(guest, newKey());
    await guest.request({ type: "voteSet", noteId: notes[0]!.id, count: 2 });
    expect(await voteRows(stub)).toHaveLength(1);
    host.send({ type: "endSession" });
    await guest.waitClose();
    await settle();
    const rows = await allRows(stub);
    expect(Object.keys(rows)).toEqual(["meta"]);
    expect(rows.meta!.map((r) => r.key)).toEqual(["ended_at"]);
  });

  it("expiry drops the votes table and the voting state; the tombstone stays", async () => {
    const { host, guest, stub, notes } = await votingRoom();
    await start(host, [guest]);
    await claim(guest, newKey());
    await guest.request({ type: "voteSet", noteId: notes[0]!.id, count: 2 });
    closeAll(host, guest);
    await host.waitClose();
    await guest.waitClose();
    await settle();
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const rows = await allRows(stub);
    expect(Object.keys(rows)).toEqual(["meta"]);
    expect(rows.meta!.map((r) => r.key)).toEqual(["expired_at"]);
  });
});

describe("protocol v13", () => {
  it("a protocol v12 page is refused with version_mismatch (please reload)", async () => {
    const { code } = await newRoom();
    const c = await TestClient.open(code);
    expect(PROTOCOL_VERSION).toBe(13);
    expect(await c.request({ type: "hello", protocolVersion: 12 })).toMatchObject({ type: "error", code: "version_mismatch" });
    expect(await c.request({ type: "join", name: "Priya" })).toMatchObject({ type: "error", code: "bad_message" });
    c.close();
  });
});

const version = (sql: SqlStorage) => sql.exec<{ value: number }>("SELECT value FROM meta WHERE key = 'schema_version'").one().value;
const VOTER_A = "a".repeat(43);
const VOTER_B = "b".repeat(43);

describe(`schema migration 7 -> ${SCHEMA_VERSION}`, () => {
  it("adds the votes table (every column with a DEFAULT, voter and note as the key); notes, frames and meta untouched", async () => {
    const { stub } = await newRoom();
    await runInDurableObject(stub, (_room, state) => {
      const sql = state.storage.sql;
      loadSchemaV7(sql);
      const store = new NoteStore(sql);
      expect(SCHEMA_VERSION).toBe(8);
      expect(version(sql)).toBe(8);
      expect(store.all().map((n) => n.id)).toEqual(V5_NOTES.map((n) => n.id));
      expect(store.allFrames().map((f) => f.id)).toEqual(V6_FRAMES.map((f) => f.id));
      expect(store.getMeta("locked")).toBe(1);
      const columns = sql.exec<{ name: string; dflt_value: string | null; notnull: number; pk: number }>("SELECT name, dflt_value, \"notnull\", pk FROM pragma_table_info('votes')").toArray();
      expect(columns.map((c) => [c.name, c.dflt_value, c.notnull, c.pk])).toEqual([
        ["voter_id", "''", 1, 1],
        ["note_id", "''", 1, 2],
        ["count", "0", 1, 0],
      ]);
      expect(store.totals()).toEqual([]);
    });
  });

  it("runs once (a second load writes nothing) and is idempotent if the table already exists", async () => {
    const { stub } = await newRoom();
    await runInDurableObject(stub, (_room, state) => {
      const sql = state.storage.sql;
      loadSchemaV7(sql);
      // An interrupted migration: the table made, version still 7.
      sql.exec("CREATE TABLE votes (voter_id TEXT NOT NULL DEFAULT '', note_id TEXT NOT NULL DEFAULT '', count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (voter_id, note_id))");
      new NoteStore(sql);
      expect(version(sql)).toBe(SCHEMA_VERSION);
      expect(new NoteStore(sql).rowsWritten).toBe(0);
    });
  });

  it("v12 code's note insert and delete still work on schema 8; votes it left behind on a deleted note are ignored (rollback safety)", async () => {
    const { code, stub } = await newRoom();
    const [first, second] = [V5_NOTES[0].id, V5_NOTES[1].id];
    await runInDurableObject(stub, (_room, state) => {
      const sql = state.storage.sql;
      loadSchemaV7(sql);
      const store = new NoteStore(sql);
      store.setVote(VOTER_A, first, 2);
      store.setVote(VOTER_B, first, 1);
      store.setVote(VOTER_A, second, 3);
      // Then v12 code (after a rollback) adds a note and deletes one: it knows nothing of votes.
      sql.exec(V7_NOTE_INSERT, "fromV12code00001", 0, 0, 160, 160, "New", "green", "m", 0, 0, "auto", "left", "left", "m", 0, 0, "auto", 9, 1, "AAAAAAAAAAAAAAAA");
      sql.exec(V7_NOTE_DELETE, first);
      // Voting state as v13 left it: closed, so a joiner gets the totals.
      store.setMeta({ voting_state: 2, voting_budget: 5, voting_round: 1 });
    });
    await evictDurableObject(stub, { webSockets: "close" });
    const c = await TestClient.open(code);
    await c.enter("Priya");
    expect(c.snapshot?.notes.map((n) => n.id)).toContain("fromV12code00001");
    // The orphaned rows of the deleted note don't count (its id is random, so it never comes back).
    expect(await c.next()).toEqual({ type: "votesRevealed", round: 1, totals: [{ noteId: second, count: 3 }] });
    c.close();
  });

  it("votes and the voting state survive a restart; bad stored rows are skipped (never fatal)", async () => {
    const { code, stub } = await newRoom();
    const c = await TestClient.open(code);
    await c.enter("Alex");
    const note = await addNote(c, "n1");
    c.close();
    await c.waitClose();
    await runInDurableObject(stub, (_room, state) => {
      const store = new NoteStore(state.storage.sql);
      store.setVote(VOTER_A, note.id, 2);
      state.storage.sql.exec("INSERT INTO votes (voter_id, note_id, count) VALUES (?, ?, ?)", VOTER_B, note.id, -4);
      state.storage.sql.exec("INSERT INTO votes (voter_id, note_id, count) VALUES (?, ?, ?)", "c".repeat(43), note.id, 500);
      store.setMeta({ voting_state: 2, voting_budget: 99, voting_round: 3 });
    });
    await evictDurableObject(stub, { webSockets: "close" });
    const d = await TestClient.open(code);
    // A budget out of range falls back to the default.
    expect((await d.enter("Priya")).voting).toEqual({ state: "closed", budget: VOTE_BUDGET_DEFAULT, round: 3 });
    expect(await d.next()).toEqual({ type: "votesRevealed", round: 3, totals: [{ noteId: note.id, count: 2 }] });
    d.close();
  });
});
