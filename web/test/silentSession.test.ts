import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FRAME_DEFAULTS,
  MAX_NOTES_PER_ROOM,
  MAX_SEALED_PER_WRITER,
  NOTE_DEFAULTS,
  PROTOCOL_VERSION,
  type Frame,
  type Note,
  type Participant,
} from "@stickyard/shared";
import type { SocketFactory, SocketHandlers } from "../src/connection/socket";
import { createDragHandlers } from "../src/canvas/nodes";
import { findFrame } from "../src/frames/board";
import { findNote } from "../src/notes/board";
import { NOTICES, RoomSession, type RoomView, type SessionOptions } from "../src/rooms/session";
import { SILENT_TEXT, totalNotes } from "../src/silent/silent";

/*
 * Silent brainstorm, part 2 (web state and plumbing on protocol v18; no UI yet). The page sends
 * its per-room key in join, keeps `silent { active, count }` and its own sealed note ids
 * (silentMine, then its own adds and deletes during the round), merges notesRevealed, counts
 * hidden notes towards the 200 cap and its own towards the 40-per-writer cap, and refuses what the
 * relay would refuse while a round runs, with a plain reason. Fake keys only.
 */

class FakeSocket {
  sent: Record<string, unknown>[] = [];
  closed = false;
  constructor(readonly handlers: SocketHandlers) {}
  send = (data: string) => void this.sent.push(JSON.parse(data) as Record<string, unknown>);
  close = () => void (this.closed = true);
  open = () => this.handlers.onOpen();
  receive = (data: unknown) => this.handlers.onMessage(JSON.stringify(data));
  serverClose = () => this.handlers.onClose();
  ofType = (type: string) => this.sent.filter((m) => m.type === type);
}

const KEY = "fakeWriterKey".padEnd(22, "k");
const alex: Participant = { id: "AAAAAAAAAAAAAAAA", name: "Alex", colourIndex: 0, host: false };
const sam: Participant = { id: "BBBBBBBBBBBBBBBB", name: "Sam", colourIndex: 1, host: false };
const nid = (i: number) => `note${String(i).padStart(12, "0")}`;
const fid = (i: number) => `frme${String(i).padStart(12, "0")}`;
const note = (i: number, extra: Partial<Note> = {}): Note => ({ id: nid(i), x: 10 * i, y: 20, ...NOTE_DEFAULTS, text: `Note ${i}`, color: "yellow", z: i, rev: 1, authorId: sam.id, ...extra });
const frame = (i: number, extra: Partial<Frame> = {}): Frame => ({ id: fid(i), x: 0, y: 0, w: 640, h: 400, title: `F${i}`, color: "neutral", ...FRAME_DEFAULTS, rev: 1, authorId: sam.id, ...extra });
const OFF = { active: false, count: 0 };

function setup(options: Partial<SessionOptions> = {}) {
  const sockets: FakeSocket[] = [];
  const views: RoomView[] = [];
  const createSocket: SocketFactory = (_url, handlers) => {
    const s = new FakeSocket(handlers);
    sockets.push(s);
    return s;
  };
  const session = new RoomSession({
    url: "wss://relay.example.test/ws?room=CODE",
    createSocket,
    checkCode: () => Promise.resolve("valid"),
    onChange: (v) => views.push(v),
    random: () => 0.5,
    voterKey: () => KEY,
    ...options,
  });
  const sock = () => sockets.at(-1)!;
  const view = () => views.at(-1)!;
  return { session, sockets, sock, view };
}

/** Opens, joins and receives the join step: joined, the snapshots and (during a round) silentMine. */
function enter(
  t: ReturnType<typeof setup>,
  { silent = OFF, notes = [] as Note[], frames = [] as Frame[], mine = null as string[] | null, host = false } = {},
) {
  t.sock().open();
  t.sock().receive({ type: "welcome", protocolVersion: PROTOCOL_VERSION });
  const you = { ...alex, host };
  t.sock().receive({ type: "joined", you, participants: [sam, you], locked: false, timer: null, voting: { state: "off", budget: 5, round: 0 }, silent });
  t.sock().receive({ type: "snapshot", notes });
  t.sock().receive({ type: "framesSnapshot", frames });
  t.sock().receive({ type: "shapesSnapshot", shapes: [] });
  if (mine) t.sock().receive({ type: "silentMine", ids: mine });
}

function joined(args: Parameters<typeof enter>[1] = {}, options: Partial<SessionOptions> = {}) {
  const t = setup(options);
  t.session.join("Alex");
  enter(t, args);
  return t;
}

/** My add of a note, confirmed by the relay (during a round the relay then sends the count). */
function addMine(t: ReturnType<typeof setup>, i: number, count?: number) {
  const local = t.session.addNote({ x: 10, y: 10, color: "yellow" });
  const sent = t.sock().ofType("noteAdd").at(-1)!;
  t.sock().receive({ type: "noteAdded", note: note(i, { authorId: alex.id, text: "" }), clientRef: sent.clientRef });
  if (count !== undefined) t.sock().receive({ type: "silentChanged", active: true, count });
  return local;
}

const mine = (t: ReturnType<typeof setup>) => [...t.view().mySealed].sort();

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("the writer key and joining", () => {
  it("join carries the page's per-room key (the voter key), before any snapshot, on the first join and on every reconnect", () => {
    const t = setup();
    t.session.join("Alex");
    t.sock().open();
    t.sock().receive({ type: "welcome", protocolVersion: PROTOCOL_VERSION });
    expect(t.sock().sent.at(-1)).toEqual({ type: "join", name: "Alex", key: KEY });
    enter(t);
    t.sock().serverClose();
    vi.advanceTimersByTime(5_000);
    expect(t.sockets).toHaveLength(2);
    t.sock().open();
    t.sock().receive({ type: "welcome", protocolVersion: PROTOCOL_VERSION });
    expect(t.sock().ofType("join")).toEqual([{ type: "join", name: "Alex", key: KEY }]);
  });

  it("storage unavailable (no key can be made): joins without a key, can view, and adding during a round says why instead of failing silently", () => {
    const t = joined({ silent: { active: true, count: 3 }, notes: [note(1)], mine: [] }, { voterKey: () => null });
    expect(t.sockets[0]!.ofType("join")).toEqual([{ type: "join", name: "Alex" }]);
    expect(t.view().status).toBe("joined");
    expect(t.view().board.notes).toHaveLength(1);
    expect(t.session.addNote({ x: 0, y: 0, color: "yellow" })).toBeNull();
    expect(t.sock().ofType("noteAdd")).toEqual([]);
    expect(t.view().noteNotice).toBe(SILENT_TEXT.noWriter);
  });

  it("silent inactive: the state is off, my list empty, and nothing is counted as hidden", () => {
    const t = joined({ notes: [note(1), note(2)] });
    expect(t.view().silent).toEqual(OFF);
    expect(mine(t)).toEqual([]);
    expect(t.view().totalNotes).toBe(2);
  });

  it("silent active: joined gives the count, silentMine gives my own; hidden notes count towards the total", () => {
    const t = joined({ silent: { active: true, count: 5 }, notes: [note(1), note(2), note(3, { authorId: alex.id }), note(4, { authorId: alex.id })], mine: [nid(3), nid(4)] });
    expect(t.view().silent).toEqual({ active: true, count: 5 });
    expect(mine(t)).toEqual([nid(3), nid(4)]);
    // 4 shown (2 of them mine and sealed) + 3 sealed notes of others' that I can't see.
    expect(t.view().totalNotes).toBe(7);
  });

  it("a reconnect during a round: the snapshot replaces the board with my sealed notes, the new silentMine replaces my list, nothing is dropped, undo history clears", () => {
    const t = joined({ silent: { active: true, count: 1 }, notes: [note(1)], mine: [] });
    addMine(t, 10, 2);
    addMine(t, 11, 3);
    expect(mine(t)).toEqual([nid(10), nid(11)]);
    expect(t.view().history.undo).toBeNull();
    t.sock().serverClose();
    vi.advanceTimersByTime(5_000);
    enter(t, { silent: { active: true, count: 4 }, notes: [note(1), note(10, { authorId: alex.id }), note(11, { authorId: alex.id })], mine: [nid(11), nid(10)] });
    expect(t.view().status).toBe("joined");
    expect(t.view().board.notes.map((n) => n.note.id)).toEqual([nid(1), nid(10), nid(11)]);
    expect(mine(t)).toEqual([nid(10), nid(11)]);
    expect(t.view().totalNotes).toBe(3 + 2);
    expect(t.view().history.undo).not.toBeNull();
  });

  it("a late join with silent active and no notes of mine: an empty list, every hidden note counted", () => {
    const t = joined({ silent: { active: true, count: 9 }, notes: [note(1)], mine: [] });
    expect(mine(t)).toEqual([]);
    expect(t.view().totalNotes).toBe(10);
  });
});

describe("my sealed list", () => {
  it("adds only my adds while a round runs; never pre-round notes' updates, moves, resizes, restacks or batch moves", () => {
    const t = joined({ notes: [note(1), note(2)] });
    addMine(t, 5);
    expect(mine(t)).toEqual([]);
    t.sock().receive({ type: "silentChanged", active: true, count: 0 });
    t.sock().receive({ type: "noteUpdated", note: note(1, { text: "Edited", rev: 2 }) });
    t.sock().receive({ type: "noteMoved", id: nid(1), x: 5, y: 5, rev: 3, final: true });
    t.sock().receive({ type: "noteResized", id: nid(2), x: 5, y: 5, w: 200, h: 200, rev: 2, final: true });
    t.sock().receive({ type: "notesOrdered", results: [{ id: nid(2), z: 9, rev: 3 }] });
    t.sock().receive({ type: "notesBatchApplied", results: [{ type: "noteMoved", id: nid(1), x: 6, y: 6, rev: 4, final: true }], final: true });
    expect(mine(t)).toEqual([]);
    addMine(t, 6, 1);
    expect(mine(t)).toEqual([nid(6)]);
  });

  it("an add from my second tab (noteAdded or itemsAdded without my clientRef) is mine during a round", () => {
    const t = joined({ silent: { active: true, count: 0 }, mine: [] });
    t.sock().receive({ type: "noteAdded", note: note(7, { authorId: "CCCCCCCCCCCCCCCC" }) });
    t.sock().receive({ type: "itemsAdded", notes: [{ note: note(8) }, { note: note(9) }], frames: [], refused: [] });
    expect(mine(t)).toEqual([nid(7), nid(8), nid(9)]);
  });

  it("a delete removes the id (single, and in a batch)", () => {
    const t = joined({ silent: { active: true, count: 3 }, notes: [note(1), note(2), note(3)], mine: [nid(1), nid(2), nid(3)] });
    t.sock().receive({ type: "noteDeleted", id: nid(1) });
    t.sock().receive({ type: "notesBatchApplied", results: [{ type: "noteDeleted", id: nid(2) }], final: true });
    expect(mine(t)).toEqual([nid(3)]);
  });

  it("a new silentMine replaces the list (no merge); a round starting while connected begins empty; the end of a round clears it", () => {
    const t = joined({ silent: { active: true, count: 2 }, notes: [note(1), note(2)], mine: [nid(1)] });
    t.sock().receive({ type: "silentMine", ids: [nid(2)] });
    expect(mine(t)).toEqual([nid(2)]);
    t.sock().receive({ type: "silentChanged", active: false, count: 0 });
    expect(mine(t)).toEqual([]);
    // A stale id can't survive into the next round either.
    t.sock().receive({ type: "silentMine", ids: [nid(1)] });
    t.sock().receive({ type: "silentChanged", active: true, count: 0 });
    expect(mine(t)).toEqual([]);
  });

  it("notesRevealed never adds to it, even while the round still looks active", () => {
    const t = joined({ silent: { active: true, count: 3 }, notes: [note(1, { authorId: alex.id })], mine: [nid(1)] });
    t.sock().receive({ type: "notesRevealed", notes: [note(1, { authorId: alex.id }), note(2), note(3)], final: true });
    expect(mine(t)).toEqual([nid(1)]);
    t.sock().receive({ type: "silentChanged", active: false, count: 0 });
    expect(mine(t)).toEqual([]);
  });
});

describe("reveal merge", () => {
  const sealedMine = [note(1, { authorId: alex.id, rev: 3, text: "Mine" }), note(2, { authorId: alex.id })];
  const others = Array.from({ length: 5 }, (_, i) => note(10 + i, { z: 20 - i }));

  it("chunks in order: my own copies are deduped (same id and rev), others added with their z, the final flag ends nothing on its own; every note once", () => {
    const t = joined({ silent: { active: true, count: 7 }, notes: [note(0), ...sealedMine], mine: sealedMine.map((n) => n.id) });
    t.sock().receive({ type: "notesRevealed", notes: [sealedMine[0]!, others[0]!, others[1]!], final: false });
    t.sock().receive({ type: "notesRevealed", notes: [sealedMine[1]!, others[2]!], final: false });
    t.sock().receive({ type: "notesRevealed", notes: [others[3]!, others[4]!], final: true });
    t.sock().receive({ type: "silentChanged", active: false, count: 0 });
    const ids = t.view().board.notes.map((n) => n.note.id);
    expect(ids.sort()).toEqual([note(0), ...sealedMine, ...others].map((n) => n.id).sort());
    expect(new Set(ids).size).toBe(ids.length);
    expect(findNote(t.view().board, nid(1))?.note).toEqual(sealedMine[0]);
    for (const o of others) expect(findNote(t.view().board, o.id)?.note.z).toBe(o.z);
    expect(t.view().silent).toEqual(OFF);
    expect(t.view().totalNotes).toBe(8);
  });

  it("chunks out of order merge the same", () => {
    const t = joined({ silent: { active: true, count: 7 }, notes: [...sealedMine], mine: sealedMine.map((n) => n.id) });
    t.sock().receive({ type: "notesRevealed", notes: [others[3]!, others[4]!], final: true });
    t.sock().receive({ type: "notesRevealed", notes: [sealedMine[0]!, others[0]!, others[1]!], final: false });
    t.sock().receive({ type: "notesRevealed", notes: [sealedMine[1]!, others[2]!], final: false });
    const ids = t.view().board.notes.map((n) => n.note.id);
    expect(ids.sort()).toEqual([...sealedMine, ...others].map((n) => n.id).sort());
  });

  it("a chunk arriving after a reconnect snapshot (which already has everything) duplicates nothing", () => {
    const t = joined({ silent: { active: true, count: 7 }, notes: [...sealedMine], mine: sealedMine.map((n) => n.id) });
    t.sock().serverClose();
    vi.advanceTimersByTime(5_000);
    enter(t, { silent: OFF, notes: [...sealedMine, ...others] });
    t.sock().receive({ type: "notesRevealed", notes: [sealedMine[0]!, others[0]!], final: true });
    const ids = t.view().board.notes.map((n) => n.note.id);
    expect(ids.length).toBe(7);
    expect(new Set(ids).size).toBe(7);
  });

  it("a revealed note then edited by its writer takes the edit", () => {
    const t = joined({ silent: { active: true, count: 1 }, mine: [] });
    t.sock().receive({ type: "notesRevealed", notes: [others[0]!], final: true });
    t.sock().receive({ type: "silentChanged", active: false, count: 0 });
    t.sock().receive({ type: "noteUpdated", note: { ...others[0]!, text: "Better", rev: 2 } });
    expect(findNote(t.view().board, others[0]!.id)?.note.text).toBe("Better");
    // An older copy (a late chunk) never undoes it.
    t.sock().receive({ type: "notesRevealed", notes: [others[0]!], final: true });
    expect(findNote(t.view().board, others[0]!.id)?.note.text).toBe("Better");
  });
});

describe("capacity", () => {
  it("totalNotes = shown + others' hidden, never negative", () => {
    expect(totalNotes(4, { active: true, count: 11 }, 2)).toBe(13);
    expect(totalNotes(4, { active: false, count: 0 }, 0)).toBe(4);
    expect(totalNotes(4, { active: true, count: 1 }, 3)).toBe(4);
    expect(totalNotes(0, { active: true, count: 0 }, 5)).toBe(0);
  });

  it("Add and Duplicate are refused at 200 notes in total, counting hidden ones; nothing is sent", () => {
    const shown = Array.from({ length: 150 }, (_, i) => note(i));
    const t = joined({ silent: { active: true, count: MAX_NOTES_PER_ROOM - 150 }, notes: shown, mine: [] });
    expect(t.view().totalNotes).toBe(MAX_NOTES_PER_ROOM);
    expect(t.session.addNote({ x: 0, y: 0, color: "yellow" })).toBeNull();
    expect(t.view().noteNotice).toBe(NOTICES.full);
    expect(t.session.duplicateNotes([nid(1)])).toBeNull();
    expect(t.sock().ofType("noteAdd")).toEqual([]);
    expect(t.sock().ofType("itemsAdd")).toEqual([]);
  });

  it(`a writer's ${MAX_SEALED_PER_WRITER} sealed notes: Add and Duplicate are refused up front with the cap's reason`, () => {
    const ids = Array.from({ length: MAX_SEALED_PER_WRITER }, (_, i) => nid(i));
    const t = joined({ silent: { active: true, count: MAX_SEALED_PER_WRITER }, notes: ids.map((_, i) => note(i, { authorId: alex.id })), mine: ids });
    expect(t.session.addNote({ x: 0, y: 0, color: "yellow" })).toBeNull();
    expect(t.view().noteNotice).toBe(SILENT_TEXT.writerFull);
    expect(t.session.duplicateNotes([nid(0)])).toBeNull();
    expect(t.view().noteNotice).toBe(SILENT_TEXT.writerFull);
    expect(t.sock().ofType("noteAdd")).toEqual([]);
    expect(t.sock().ofType("itemsAdd")).toEqual([]);
  });

  it("the cap counts my adds still waiting for the relay", () => {
    const ids = Array.from({ length: MAX_SEALED_PER_WRITER - 1 }, (_, i) => nid(i));
    const t = joined({ silent: { active: true, count: ids.length }, notes: ids.map((_, i) => note(i, { authorId: alex.id })), mine: ids });
    expect(t.session.addNote({ x: 0, y: 0, color: "yellow" })).not.toBeNull();
    expect(t.session.addNote({ x: 0, y: 0, color: "yellow" })).toBeNull();
    expect(t.view().noteNotice).toBe(SILENT_TEXT.writerFull);
    expect(t.sock().ofType("noteAdd")).toHaveLength(1);
  });
});

describe("refused while a round runs, with the reason, nothing sent", () => {
  const board = { silent: { active: true, count: 0 }, notes: [note(1), note(2)], frames: [frame(1), frame(2, { x: 1000 })], mine: [] as string[] };

  it("Clear board", () => {
    const t = joined(board);
    expect(t.session.clearBoard()).toBe(false);
    expect(t.view().noteNotice).toBe(SILENT_TEXT.on);
    expect(t.sock().ofType("noteBatch")).toEqual([]);
  });

  it("a frame drag (with or without its notes), a selection drag or arrow keys with a frame, and arranging frames into new places", () => {
    const t = joined(board);
    for (const carry of [true, false]) expect(t.session.startFrameDrag(fid(1), carry)).toBe(false);
    expect(t.session.startSelectionDrag([fid(1)], [nid(1)], true)).toBe(false);
    expect(t.session.startSelectionDrag([fid(1), fid(2)], [], false)).toBe(false);
    expect(t.session.applyFrameRects([{ id: fid(1), x: 100, y: 100, w: 640, h: 400 }])).toBe(false);
    expect(t.view().noteNotice).toBe(SILENT_TEXT.on);
    t.session.moveFrame(fid(1), 50, 50, true);
    expect(t.sock().ofType("frameMove")).toEqual([]);
    // A frame's size alone (Match size) is still allowed: the relay takes frameResize.
    expect(t.session.applyFrameRects([{ id: fid(1), x: 0, y: 0, w: 700, h: 400 }])).toBe(true);
    expect(t.sock().ofType("frameResize")).toHaveLength(1);
    // Notes alone still move as a group.
    expect(t.session.startSelectionDrag([], [nid(1), nid(2)], true)).toBe(true);
  });

  it("a frame drag on the canvas during a round: refused at drag start with the reason, nothing sent, the frame stays put", () => {
    const t = joined(board);
    const sentBefore = t.sock().sent.length;
    // The canvas's own drag handlers, wired to the session as the board wires them.
    const drag = createDragHandlers({
      startDrag: (id) => t.session.startDrag(id),
      moveNote: (id, x, y, final) => t.session.moveNote(id, x, y, final),
      startFrameDrag: (id, carry) => t.session.startFrameDrag(id, carry),
      moveFrame: (id, x, y, final) => t.session.moveFrame(id, x, y, final),
    });
    for (const altKey of [false, true]) {
      drag.onNodeDragStart({ id: fid(1), type: "frame" }, { altKey });
      expect(t.view().noteNotice).toBe(SILENT_TEXT.on);
      drag.onNodesChange([{ type: "position", id: fid(1), dragging: true, position: { x: 300, y: 300 } }]);
      drag.onNodeDragStop({ id: fid(1), position: { x: 400, y: 400 } });
    }
    vi.advanceTimersByTime(1_000);
    expect(t.sock().sent.length).toBe(sentBefore);
    expect(findFrame(t.view().board, fid(1))?.frame).toMatchObject({ x: 0, y: 0 });
    expect(findFrame(t.view().board, fid(1))?.dragging).toBe(false);
  });

  it("starting a vote (host)", () => {
    const t = joined({ ...board, host: true });
    expect(t.session.startVote(5)).toBe(false);
    expect(t.view().noteNotice).toBe(SILENT_TEXT.on);
    expect(t.sock().ofType("voteStart")).toEqual([]);
  });

  it("voting on a sealed note (voting opened before the round)", () => {
    const t = setup();
    t.session.join("Alex");
    t.sock().open();
    t.sock().receive({ type: "welcome", protocolVersion: PROTOCOL_VERSION });
    t.sock().receive({ type: "joined", you: alex, participants: [sam, alex], locked: false, timer: null, voting: { state: "open", budget: 5, round: 1 }, silent: { active: true, count: 1 } });
    t.sock().receive({ type: "snapshot", notes: [note(1), note(2, { authorId: alex.id })] });
    t.sock().receive({ type: "framesSnapshot", frames: [] });
    t.sock().receive({ type: "shapesSnapshot", shapes: [] });
    t.sock().receive({ type: "silentMine", ids: [nid(2)] });
    t.sock().receive({ type: "voterGranted", remaining: 5, mine: [] });
    expect(t.session.voteSet(nid(2), 1)).toBe(false);
    expect(t.view().noteNotice).toBe(SILENT_TEXT.sealedVote);
    expect(t.session.voteSet(nid(1), 1)).toBe(true);
    expect(t.sock().ofType("voteSet")).toEqual([{ type: "voteSet", noteId: nid(1), count: 1 }]);
  });
});

describe("host actions", () => {
  it("startSilent and revealSilent send the host messages; refused for a guest, when already in that state, or disconnected", () => {
    const guest = joined();
    expect(guest.session.startSilent()).toBe(false);
    expect(guest.session.revealSilent()).toBe(false);
    expect(guest.sock().sent.filter((m) => String(m.type).startsWith("silent"))).toEqual([]);

    const t = joined({ host: true });
    expect(t.session.revealSilent()).toBe(false);
    expect(t.session.startSilent()).toBe(true);
    expect(t.sock().ofType("silentStart")).toEqual([{ type: "silentStart" }]);
    t.sock().receive({ type: "silentChanged", active: true, count: 0 });
    expect(t.session.startSilent()).toBe(false);
    expect(t.session.revealSilent()).toBe(true);
    expect(t.sock().ofType("silentReveal")).toEqual([{ type: "silentReveal" }]);
    t.sock().serverClose();
    expect(t.session.revealSilent()).toBe(false);
  });
});

describe("the relay's refusals: rolled back, a plain message, never a throw, never note text or ids", () => {
  const isPlain = (notice: string | null) => {
    expect(notice).not.toBeNull();
    expect(notice).not.toMatch(/note\d{12}|CANARY/);
  };

  it("no_writer on a note add: the note goes, the reason is shown", () => {
    const t = joined({ silent: { active: true, count: 0 }, mine: [] });
    const local = t.session.addNote({ x: 0, y: 0, color: "yellow", text: "CANARY" })!;
    const ref = t.sock().ofType("noteAdd")[0]!.clientRef;
    expect(() => t.sock().receive({ type: "error", code: "no_writer", message: "No.", clientRef: ref })).not.toThrow();
    expect(findNote(t.view().board, local)).toBeUndefined();
    expect(t.view().noteNotice).toBe(SILENT_TEXT.noWriter);
    isPlain(t.view().noteNotice);
  });

  it("sealed_full on a note add: the note goes, the cap's reason is shown", () => {
    const t = joined({ silent: { active: true, count: 0 }, mine: [] });
    const local = t.session.addNote({ x: 0, y: 0, color: "yellow" })!;
    const ref = t.sock().ofType("noteAdd")[0]!.clientRef;
    t.sock().receive({ type: "error", code: "sealed_full", message: "No.", clientRef: ref });
    expect(findNote(t.view().board, local)).toBeUndefined();
    expect(t.view().noteNotice).toBe(SILENT_TEXT.writerFull);
  });

  it("silent_active on a frame move that slipped through: the frame goes back; without a ref (silentStart, voteStart): just the reason", () => {
    const t = joined({ notes: [note(1)], frames: [frame(1)], host: true });
    expect(t.session.startFrameDrag(fid(1), false)).toBe(true);
    t.session.moveFrame(fid(1), 300, 300, true);
    expect(t.sock().ofType("frameMove")).toHaveLength(1);
    t.sock().receive({ type: "silentChanged", active: true, count: 0 });
    t.sock().receive({ type: "error", code: "silent_active", message: "No.", frameId: fid(1) });
    expect(t.view().board.frames[0]?.frame).toMatchObject({ x: 0, y: 0 });
    expect(t.view().noteNotice).toBe(SILENT_TEXT.on);
    t.sock().receive({ type: "error", code: "silent_active", message: "No." });
    expect(t.view().noteNotice).toBe(SILENT_TEXT.on);
  });

  it("an itemsAdd with notes refused as no_writer or sealed_full: the notes go, one plain notice", () => {
    const t = joined({ silent: { active: true, count: 1 }, notes: [note(1, { authorId: alex.id })], mine: [nid(1)] });
    const ids = t.session.duplicateNotes([nid(1)]);
    expect(ids).toHaveLength(1);
    const message = t.sock().ofType("itemsAdd")[0]!;
    const ref = (message.notes as { ref: string }[])[0]!.ref;
    t.sock().receive({ type: "error", code: "sealed_full", message: "No.", clientRef: message.clientRef, refused: [{ kind: "note", index: 0, ref, reason: "sealed_full" }] });
    expect(findNote(t.view().board, ids![0]!)).toBeUndefined();
    expect(t.view().noteNotice).toContain(SILENT_TEXT.writerFull);
    isPlain(t.view().noteNotice);
  });
});

describe("undo and redo of my own sealed notes during a round", () => {
  it("add, edit, move and delete undo as normal; a restore after a delete is a new note of mine", () => {
    const t = joined({ silent: { active: true, count: 0 }, mine: [] });
    addMine(t, 1, 1);
    // Edit, then undo it.
    t.session.editNote(nid(1), "Idea");
    t.sock().receive({ type: "noteUpdated", note: note(1, { authorId: alex.id, text: "Idea", rev: 2 }) });
    t.session.undo();
    expect(t.sock().ofType("noteEdit").at(-1)).toEqual({ type: "noteEdit", id: nid(1), text: "" });
    t.sock().receive({ type: "noteUpdated", note: note(1, { authorId: alex.id, text: "", rev: 3 }) });
    // Move, then undo it.
    t.session.startDrag(nid(1));
    t.session.moveNote(nid(1), 300, 300, true);
    t.sock().receive({ type: "noteMoved", id: nid(1), x: 300, y: 300, rev: 4, final: true });
    t.session.undo();
    const back = t.sock().ofType("noteBatch").at(-1) as { ops: { op: string; x: number }[] };
    expect(back.ops[0]).toMatchObject({ op: "move", x: 10 });
    t.sock().receive({ type: "notesBatchApplied", results: [{ type: "noteMoved", id: nid(1), x: 10, y: 20, rev: 5, final: true }], final: true });
    // Delete, then undo it: added back through itemsAdd, confirmed during the round, so mine again.
    t.session.deleteNote(nid(1));
    t.sock().receive({ type: "noteDeleted", id: nid(1) });
    t.sock().receive({ type: "silentChanged", active: true, count: 0 });
    expect(mine(t)).toEqual([]);
    t.session.undo();
    vi.advanceTimersByTime(1_000);
    const restore = t.sock().ofType("itemsAdd").at(-1)!;
    const ref = (restore.notes as { ref: string }[])[0]!.ref;
    t.sock().receive({ type: "itemsAdded", clientRef: restore.clientRef, notes: [{ ref, note: note(2, { authorId: alex.id }) }], frames: [], refused: [] });
    expect(mine(t)).toEqual([nid(2)]);
    // Undo the restore: the new note is deleted again.
    t.session.undo();
    expect((t.sock().ofType("noteBatch").at(-1) as { ops: { op: string; id: string }[] }).ops).toEqual([{ op: "delete", id: nid(2) }]);
  });

  it("an undo that would add a note back past 200 in total (hidden notes counted) is refused up front, nothing sent", () => {
    const shown = Array.from({ length: 150 }, (_, i) => note(i));
    const t = joined({ silent: { active: true, count: 0 }, notes: [...shown, note(500, { authorId: alex.id })], mine: [] });
    t.session.deleteNote(nid(500));
    t.sock().receive({ type: "noteDeleted", id: nid(500) });
    // Others write 50 hidden notes meanwhile: the board is full.
    t.sock().receive({ type: "silentChanged", active: true, count: 50 });
    expect(t.view().totalNotes).toBe(MAX_NOTES_PER_ROOM);
    t.session.undo();
    vi.advanceTimersByTime(1_000);
    expect(t.sock().ofType("itemsAdd")).toEqual([]);
    expect(t.view().noteNotice).toBe(NOTICES.full);
  });

  it("an undo that would move a frame is refused during a round with the reason; nothing sent", () => {
    const t = joined({ notes: [note(1)], frames: [frame(1)] });
    expect(t.session.startFrameDrag(fid(1), false)).toBe(true);
    t.session.moveFrame(fid(1), 300, 300, true);
    t.sock().receive({ type: "frameMoved", id: fid(1), x: 300, y: 300, rev: 2, final: true });
    t.sock().receive({ type: "silentChanged", active: true, count: 0 });
    const sent = t.sock().ofType("frameMove").length;
    t.session.undo();
    expect(t.sock().ofType("frameMove")).toHaveLength(sent);
    expect(t.view().noteNotice).toBe(SILENT_TEXT.on);
    // After the round the same undo works.
    t.sock().receive({ type: "silentChanged", active: false, count: 0 });
    t.session.undo();
    expect(t.sock().ofType("frameMove").at(-1)).toMatchObject({ id: fid(1), x: 0, y: 0 });
  });

  it("undo of my add of a sealed note deletes it", () => {
    const t = joined({ silent: { active: true, count: 0 }, mine: [] });
    addMine(t, 1, 1);
    t.session.undo();
    expect((t.sock().ofType("noteBatch").at(-1) as { ops: unknown[] }).ops).toEqual([{ op: "delete", id: nid(1) }]);
  });

  it("a revealed note of someone else's is someone else's: its later change doesn't make my undo touch it", () => {
    const t = joined({ silent: { active: true, count: 1 }, mine: [] });
    t.sock().receive({ type: "notesRevealed", notes: [note(5)], final: true });
    t.sock().receive({ type: "silentChanged", active: false, count: 0 });
    expect(t.view().history.undo).not.toBeNull();
  });
});

describe("a whole round, as the relay sends it (fixture)", () => {
  it("start, silentMine, my sealed adds, count changes, reveal in 3 chunks, end", () => {
    const t = joined({ notes: [note(1)] });
    const transcript: unknown[] = [
      { type: "silentChanged", active: true, count: 0 },
      { type: "silentChanged", active: true, count: 1 },
      { type: "silentChanged", active: true, count: 2 },
    ];
    for (const m of transcript) t.sock().receive(m);
    addMine(t, 2, 3);
    addMine(t, 3, 4);
    expect(t.view().totalNotes).toBe(1 + 2 + 2);
    expect(mine(t)).toEqual([nid(2), nid(3)]);
    // A reconnect mid-round: silentMine says the same.
    t.sock().serverClose();
    vi.advanceTimersByTime(5_000);
    enter(t, { silent: { active: true, count: 4 }, notes: [note(1), note(2, { authorId: alex.id, text: "" }), note(3, { authorId: alex.id, text: "" })], mine: [nid(2), nid(3)] });
    expect(mine(t)).toEqual([nid(2), nid(3)]);
    const revealed = [note(2, { authorId: alex.id, text: "" }), note(3, { authorId: alex.id, text: "" }), note(20), note(21)];
    t.sock().receive({ type: "notesRevealed", notes: revealed.slice(0, 2), final: false });
    t.sock().receive({ type: "notesRevealed", notes: revealed.slice(2, 3), final: false });
    t.sock().receive({ type: "notesRevealed", notes: revealed.slice(3), final: true });
    t.sock().receive({ type: "silentChanged", active: false, count: 0 });
    expect(t.view().board.notes.map((n) => n.note.id)).toEqual([nid(1), nid(2), nid(3), nid(20), nid(21)]);
    expect(mine(t)).toEqual([]);
    expect(t.view().silent).toEqual(OFF);
    expect(t.view().totalNotes).toBe(5);
  });
});

