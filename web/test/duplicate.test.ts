// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BOARD_HEIGHT,
  BOARD_WIDTH,
  FRAME_DEFAULTS,
  MAX_BATCH_ENTRIES,
  MAX_FRAMES_PER_ROOM,
  MAX_MESSAGE_BYTES,
  MAX_NOTES_PER_ROOM,
  MAX_NOTE_TEXT,
  NOTE_DEFAULTS,
  NOTE_STYLE_FIELDS,
  PROTOCOL_VERSION,
  clientMessageSchema,
  type Frame,
  type Note,
  type NoteItem,
  type Participant,
} from "@stickyard/shared";
import type { SocketFactory, SocketHandlers } from "../src/connection/socket";
import { DUPLICATE_HINTS, DUPLICATE_OFFSET, duplicateDisabledReason, duplicateFrameInput, duplicateNoteInputs } from "../src/canvas/duplicate";
import { boardShortcut, type ShortcutEvent, type ShortcutState } from "../src/canvas/shortcuts";
import { findFrame } from "../src/frames/board";
import { findNote, isLocalId } from "../src/notes/board";
import { messageBytes, packItems } from "../src/rooms/items";
import { ITEMS_STEP_MS, NOTICES, RoomSession, type RoomView } from "../src/rooms/session";

/* Part 1 of the bar + undo slice: Duplicate (web only, itemsAdd), its planning, reasons and shortcut. */

const sam = "BBBBBBBBBBBBBBBB";
const nid = (i: number) => `note${String(i).padStart(12, "0")}`;
const fid = (i: number) => `frme${String(i).padStart(12, "0")}`;
const note = (i: number, extra: Partial<Note> = {}): Note => ({
  id: nid(i),
  x: 100 + i * 10,
  y: 200,
  ...NOTE_DEFAULTS,
  text: `Note ${i}`,
  color: "yellow",
  z: i,
  rev: 3,
  authorId: sam,
  ...extra,
});
const frame = (i: number, extra: Partial<Frame> = {}): Frame => ({
  id: fid(i),
  x: 100,
  y: 100,
  w: 640,
  h: 400,
  title: "Ideas",
  color: "blue",
  ...FRAME_DEFAULTS,
  rev: 2,
  authorId: sam,
  ...extra,
});

describe("the duplicate offset", () => {
  it("is mirrored by --sy-duplicate-offset in tokens.css", () => {
    const tokens = readFileSync(resolve(import.meta.dirname, "../src/styles/tokens.css"), "utf8");
    expect(DUPLICATE_OFFSET).toBeGreaterThan(0);
    expect(tokens).toContain(`--sy-duplicate-offset: ${DUPLICATE_OFFSET}px;`);
  });
});

describe("duplicateNoteInputs (pure)", () => {
  it("copies every content field exactly (text, colour, each style field, size), offset by one token", () => {
    const original = note(1, {
      w: 300,
      h: 210,
      text: "Title\nBody",
      color: "purple",
      fontSize: "xl",
      bold: true,
      italic: true,
      textColor: "red",
      align: "right",
      titleAlign: "center",
      titleFontSize: "s",
      titleBold: true,
      titleItalic: true,
      titleTextColor: "blue",
    });
    const [copy] = duplicateNoteInputs([original]);
    expect(copy).toEqual({
      kind: "note",
      x: original.x + DUPLICATE_OFFSET,
      y: original.y + DUPLICATE_OFFSET,
      w: 300,
      h: 210,
      text: "Title\nBody",
      color: "purple",
      ...Object.fromEntries(NOTE_STYLE_FIELDS.map((k) => [k, original[k]])),
    });
    // Nothing the server assigns.
    expect(copy).not.toHaveProperty("id");
    expect(copy).not.toHaveProperty("rev");
    expect(copy).not.toHaveProperty("z");
    expect(copy).not.toHaveProperty("authorId");
  });

  it("keeps the arrangement and the originals' stacking order (bottom first), whatever the selection order", () => {
    const a = note(1, { x: 10, y: 10, z: 5 });
    const b = note(2, { x: 400, y: 300, z: -2 });
    const c = note(3, { x: 50, y: 900, z: 9 });
    const copies = duplicateNoteInputs([c, a, b]);
    expect(copies.map((n) => n.kind === "note" && n.text)).toEqual([b.text, a.text, c.text]);
    expect(copies.map((n) => [n.x - DUPLICATE_OFFSET, n.y - DUPLICATE_OFFSET])).toEqual([
      [b.x, b.y],
      [a.x, a.y],
      [c.x, c.y],
    ]);
  });

  it("ties in z are broken by id, as the server stacks them", () => {
    const copies = duplicateNoteInputs([note(2, { z: 0, text: "two" }), note(1, { z: 0, text: "one" })]);
    expect(copies.map((n) => n.kind === "note" && n.text)).toEqual(["one", "two"]);
  });

  it("clamps the offset once for the group at the board's edge, so the arrangement is kept", () => {
    const right = note(1, { x: BOARD_WIDTH - 160, y: BOARD_HEIGHT - 160 });
    const left = note(2, { x: BOARD_WIDTH - 400, y: BOARD_HEIGHT - 300 });
    const copies = duplicateNoteInputs([right, left]);
    // No room to the right or below: both stay put relative to each other (offset 0 there).
    const byText = new Map(copies.map((c) => [c.kind === "note" ? c.text : "", c]));
    expect(byText.get(right.text)).toMatchObject({ x: right.x, y: right.y });
    expect(byText.get(left.text)).toMatchObject({ x: left.x, y: left.y });
    const partly = duplicateNoteInputs([note(3, { x: BOARD_WIDTH - 170, y: 0 })]);
    expect(partly[0]).toMatchObject({ x: BOARD_WIDTH - 160, y: DUPLICATE_OFFSET });
  });

  it("empty in, empty out", () => {
    expect(duplicateNoteInputs([])).toEqual([]);
  });

  it("200 copies of maximum-size notes pack into many messages, each within the cap, every copy once and in order", () => {
    const notes = Array.from({ length: MAX_NOTES_PER_ROOM }, (_, i) => note(i, { text: "\ud800".repeat(MAX_NOTE_TEXT), z: i }));
    const inputs = duplicateNoteInputs(notes);
    let n = 0;
    const drafts = inputs.map((input) => {
      const { kind: _, ...rest } = input as Extract<typeof input, { kind: "note" }>;
      return { kind: "note" as const, item: { ref: `ref${String(n++).padStart(9, "0")}`, ...rest } };
    });
    let m = 0;
    const { messages, tooLarge } = packItems(drafts, () => `msg${String(m++).padStart(9, "0")}`);
    expect(tooLarge).toEqual([]);
    expect(messages.length).toBeGreaterThanOrEqual(MAX_NOTES_PER_ROOM / 2);
    for (const message of messages) expect(messageBytes(message)).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
    expect(messages.flatMap((message) => (message.notes ?? []).map((item) => item.ref))).toEqual(drafts.map((d) => d.item.ref));
  });
});

describe("duplicateFrameInput (pure)", () => {
  it("copies the frame alone: title, colour, title style and size, offset by one token", () => {
    const f = frame(1, { title: "Retro", color: "green", titleFontSize: "xl", titleBold: false, titleItalic: true, titleTextColor: "red", titleAlign: "center", w: 900, h: 700 });
    expect(duplicateFrameInput(f)).toEqual({
      kind: "frame",
      x: f.x + DUPLICATE_OFFSET,
      y: f.y + DUPLICATE_OFFSET,
      w: 900,
      h: 700,
      title: "Retro",
      color: "green",
      titleFontSize: "xl",
      titleBold: false,
      titleItalic: true,
      titleTextColor: "red",
      titleAlign: "center",
    });
  });

  it("is clamped to the board at its size", () => {
    const f = frame(1, { x: BOARD_WIDTH - 640, y: BOARD_HEIGHT - 400 });
    expect(duplicateFrameInput(f)).toMatchObject({ x: BOARD_WIDTH - 640, y: BOARD_HEIGHT - 400 });
  });
});

describe("duplicateDisabledReason", () => {
  const ok = { notes: 2, frame: false, live: true, held: false, unsaved: false, busy: false, freeNotes: 10, freeFrames: 5 };
  it.each([
    [{ ...ok, notes: 0 }, DUPLICATE_HINTS.none],
    [{ ...ok, live: false }, DUPLICATE_HINTS.offline],
    [{ ...ok, held: true }, DUPLICATE_HINTS.held],
    [{ ...ok, unsaved: true }, DUPLICATE_HINTS.unsaved],
    [{ ...ok, busy: true }, DUPLICATE_HINTS.busy],
    [{ ...ok, notes: 11 }, DUPLICATE_HINTS.notesFull(11, 10)],
    [{ ...ok, notes: 0, frame: true, freeFrames: 0 }, DUPLICATE_HINTS.framesFull(0)],
    [ok, null],
    [{ ...ok, notes: 0, frame: true }, null],
  ])("%o -> %s", (state, reason) => {
    expect(duplicateDisabledReason(state)).toBe(reason);
  });

  it("names the counts", () => {
    expect(DUPLICATE_HINTS.notesFull(5, 3)).toBe("No room to duplicate 5 notes: the board has room for 3 more.");
    expect(DUPLICATE_HINTS.framesFull(0)).toBe(`No room to duplicate the frame: the board has the maximum of ${MAX_FRAMES_PER_ROOM} frames.`);
  });
});

describe("the Duplicate shortcut (Ctrl/Cmd+D)", () => {
  let board: HTMLElement;
  beforeEach(() => {
    document.body.innerHTML = '<main tabindex="-1"><section data-board><div class="pane"></div><input /><textarea data-inline="body"></textarea></section></main><button data-outside></button>';
    board = document.querySelector("[data-board]")!;
  });
  const ev = (extra: Partial<ShortcutEvent> = {}): ShortcutEvent => ({
    key: "d",
    target: document.body,
    defaultPrevented: false,
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...extra,
  });
  const st = (extra: Partial<ShortcutState> = {}): ShortcutState => ({ multi: true, modal: false, board, ...extra });

  it("Ctrl+D or Cmd+D on the board (or nothing focused) duplicates", () => {
    expect(boardShortcut(ev(), st())).toBe("duplicate");
    expect(boardShortcut(ev({ ctrlKey: false, metaKey: true }), st())).toBe("duplicate");
    expect(boardShortcut(ev({ key: "D" }), st())).toBe("duplicate");
    expect(boardShortcut(ev({ target: board.querySelector(".pane") }), st())).toBe("duplicate");
    expect(boardShortcut(ev({ target: document.querySelector("main") }), st())).toBe("duplicate");
  });

  it("never in a text field (inline editing, Properties), a modal, on phones, from controls elsewhere, or with Alt/Shift", () => {
    expect(boardShortcut(ev({ target: board.querySelector("input") }), st())).toBeNull();
    expect(boardShortcut(ev({ target: board.querySelector("textarea") }), st())).toBeNull();
    expect(boardShortcut(ev(), st({ modal: true }))).toBeNull();
    expect(boardShortcut(ev(), st({ multi: false }))).toBeNull();
    expect(boardShortcut(ev({ target: document.querySelector("[data-outside]") }), st())).toBeNull();
    expect(boardShortcut(ev({ altKey: true }), st())).toBeNull();
    expect(boardShortcut(ev({ shiftKey: true }), st())).toBeNull();
    expect(boardShortcut(ev({ ctrlKey: false }), st())).toBeNull();
    expect(boardShortcut(ev({ defaultPrevented: true }), st())).toBeNull();
    expect(boardShortcut(ev({ key: "x" }), st())).toBeNull();
  });
});

/* ── RoomSession.duplicateNotes / duplicateFrame ─────────────────── */

class FakeSocket {
  sent: { at: number; message: Record<string, unknown> }[] = [];
  constructor(readonly handlers: SocketHandlers) {}
  send = (data: string) => {
    this.sent.push({ at: Date.now(), message: JSON.parse(data) as Record<string, unknown> });
  };
  close = () => {};
  receive(data: unknown) {
    this.handlers.onMessage(JSON.stringify(data));
  }
}

const alex: Participant = { id: "AAAAAAAAAAAAAAAA", name: "Alex", colourIndex: 0, host: false };

function room(notes: Note[], frames: Frame[] = []) {
  let socket: FakeSocket | null = null;
  const views: RoomView[] = [];
  const createSocket: SocketFactory = (_url, handlers) => (socket = new FakeSocket(handlers));
  const s = new RoomSession({ url: "wss://relay.example.test/ws?room=CODE", createSocket, checkCode: () => Promise.resolve("valid"), onChange: (v) => views.push(v) });
  s.join("Alex");
  const sock = () => socket!;
  sock().handlers.onOpen();
  sock().receive({ type: "welcome", protocolVersion: PROTOCOL_VERSION });
  sock().receive({ type: "joined", you: alex, participants: [alex], locked: false, timer: null });
  sock().receive({ type: "snapshot", notes });
  sock().receive({ type: "framesSnapshot", frames });
  const start = sock().sent.length;
  const out = () => sock().sent.slice(start).map((m) => m.message);
  return { session: s, sock, out, view: () => views.at(-1)! };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("RoomSession.duplicateNotes", () => {
  it("adds the copies at once with full content through itemsAdd, on top, in the originals' order; returns their ids", () => {
    const a = note(1, { z: 7, color: "pink", bold: true });
    const b = note(2, { z: 3, text: "Body\nline", titleTextColor: "green" });
    const t = room([a, b, note(3, { z: 1 })]);
    const ids = t.session.duplicateNotes([a.id, b.id]);
    expect(ids).toHaveLength(2);
    expect(ids!.every(isLocalId)).toBe(true);
    const board = t.view().board;
    const [copyB, copyA] = ids!.map((id) => findNote(board, id)!.note);
    expect(copyB).toMatchObject({ text: b.text, titleTextColor: "green", x: b.x + DUPLICATE_OFFSET, y: b.y + DUPLICATE_OFFSET, authorId: alex.id });
    expect(copyA).toMatchObject({ text: a.text, color: "pink", bold: true });
    expect(copyA!.z).toBeGreaterThan(copyB!.z);
    expect(copyB!.z).toBeGreaterThan(7);
    expect(t.out().map((m) => m.type)).toEqual(["itemsAdd"]);
    expect((t.out()[0]!.notes as NoteItem[]).map((n) => n.text)).toEqual([b.text, a.text]);
    expect(clientMessageSchema.safeParse(t.out()[0]).success).toBe(true);
  });

  it("refuses, sending nothing, when there isn't room for every copy, and says so with the counts", () => {
    const notes = Array.from({ length: MAX_NOTES_PER_ROOM - 1 }, (_, i) => note(i));
    const t = room(notes);
    expect(t.session.duplicateNotes([nid(0), nid(1)])).toBeNull();
    expect(t.out()).toEqual([]);
    expect(t.view().noteNotice).toBe(NOTICES.duplicateNoRoom("note", 2, 1));
    expect(t.view().noteNotice).toBe("No room to duplicate 2 notes: the board has room for 1 more.");
    expect(t.view().board.notes).toHaveLength(MAX_NOTES_PER_ROOM - 1);
  });

  it("refuses a note that isn't confirmed or is being moved, and does nothing while disconnected", () => {
    const t = room([note(1), note(2)]);
    const temp = t.session.addNote({ x: 0, y: 0, color: "pink" })!;
    const before = t.out().length;
    expect(t.session.duplicateNotes([nid(1), temp])).toBeNull();
    t.session.startDrag(nid(2));
    expect(t.session.duplicateNotes([nid(2)])).toBeNull();
    expect(t.out()).toHaveLength(before);
    t.sock().handlers.onClose();
    expect(t.session.duplicateNotes([nid(1)])).toBeNull();
  });

  it("a 200-note duplicate (an empty board's worth) goes out as many paced messages, every copy once, in stacking order", async () => {
    const big = Array.from({ length: MAX_NOTES_PER_ROOM / 2 }, (_, i) => note(i, { text: "\ud800".repeat(MAX_NOTE_TEXT), z: MAX_NOTES_PER_ROOM - i }));
    const t = room(big);
    const ids = t.session.duplicateNotes(big.map((n) => n.id));
    expect(ids).toHaveLength(MAX_NOTES_PER_ROOM / 2);
    await vi.advanceTimersByTimeAsync(ITEMS_STEP_MS * 100);
    const messages = t.out();
    expect(messages.length).toBeGreaterThan(MAX_NOTES_PER_ROOM / 2 / MAX_BATCH_ENTRIES);
    for (const m of messages) {
      expect(m.type).toBe("itemsAdd");
      expect(messageBytes(m as never)).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
      expect(clientMessageSchema.safeParse(m).success).toBe(true);
    }
    const sentXs = messages.flatMap((m) => (m.notes as NoteItem[]).map((n) => n.x - DUPLICATE_OFFSET));
    // Stacking order is reverse of the input here (z falls as i rises).
    expect(sentXs).toEqual([...big].reverse().map((n) => n.x));
  });

  it("a full 200 copies from a board of 100 small notes (copying all of them twice would not fit): refused up front", () => {
    const hundred = Array.from({ length: 100 }, (_, i) => note(i));
    const t = room(hundred);
    expect(t.session.duplicateNotes(hundred.map((n) => n.id))).toHaveLength(100);
    expect(t.session.duplicateNotes(hundred.map((n) => n.id))).toBeNull();
    expect(t.view().noteNotice).toBe(NOTICES.duplicateNoRoom("note", 100, 0));
  });

  it("refused copies roll back on their own (itemsAdd rules) and the notice counts them", () => {
    const t = room([note(1), note(2)]);
    const ids = t.session.duplicateNotes([nid(1), nid(2)])!;
    const sent = t.out()[0]!;
    const refs = (sent.notes as NoteItem[]).map((n) => n.ref);
    t.sock().receive({
      type: "itemsAdded",
      clientRef: sent.clientRef,
      notes: [{ ref: refs[0], note: { ...note(9), id: nid(9), authorId: alex.id } }],
      frames: [],
      refused: [{ kind: "note", index: 1, ref: refs[1], reason: "notes_full" }],
    });
    expect(findNote(t.view().board, ids[1]!)).toBeUndefined();
    expect(findNote(t.view().board, nid(9))).toBeDefined();
    expect(t.view().noteNotice).toContain("1 note wasn’t added");
  });
});

describe("RoomSession.duplicateFrame", () => {
  it("copies the frame alone (not its notes) through itemsAdd and returns its id", () => {
    const f = frame(1, { title: "Plan", titleAlign: "right" });
    const inside = note(1, { x: 200, y: 200 });
    const t = room([inside], [f]);
    const id = t.session.duplicateFrame(f.id);
    expect(id && isLocalId(id)).toBe(true);
    expect(findFrame(t.view().board, id!)?.frame).toMatchObject({ title: "Plan", titleAlign: "right", x: f.x + DUPLICATE_OFFSET, y: f.y + DUPLICATE_OFFSET });
    expect(t.view().board.notes).toHaveLength(1);
    expect(t.out()).toHaveLength(1);
    expect(t.out()[0]).toMatchObject({ type: "itemsAdd" });
    expect(t.out()[0]).not.toHaveProperty("notes");
  });

  it("refuses with the count at the frame cap, and an unconfirmed frame", () => {
    const frames = Array.from({ length: MAX_FRAMES_PER_ROOM }, (_, i) => frame(i));
    const t = room([], frames);
    expect(t.session.duplicateFrame(fid(0))).toBeNull();
    expect(t.view().noteNotice).toBe(NOTICES.duplicateNoRoom("frame", 1, 0));
    const u = room([], [frame(1)]);
    const temp = u.session.addFrame({ x: 0, y: 0, color: "neutral" })!;
    expect(u.session.duplicateFrame(temp)).toBeNull();
  });
});
