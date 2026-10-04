import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BOARD_WIDTH,
  FRAME_DEFAULTS,
  MAX_BATCH_ENTRIES,
  MAX_MESSAGE_BYTES,
  MAX_NOTE_TEXT,
  NOTE_DEFAULTS,
  NOTE_MAX_W,
  PROTOCOL_VERSION,
  clientMessageSchema,
  type Frame,
  type FrameItem,
  type Note,
  type NoteItem,
  type Participant,
} from "@stickyard/shared";
import type { SocketFactory, SocketHandlers } from "../src/connection/socket";
import { findFrame } from "../src/frames/board";
import { findNote, isLocalId } from "../src/notes/board";
import { messageBytes, packItems, type ItemDraft } from "../src/rooms/items";
import { ITEMS_MESSAGES_PER_SECOND, ITEMS_STEP_MS, NOTICES, RoomSession, type ItemInput, type RoomView } from "../src/rooms/session";

/* Protocol v11 (slice create with content), web side: packing and RoomSession.addItems. Generic fixtures. */

const alex: Participant = { id: "AAAAAAAAAAAAAAAA", name: "Alex", colourIndex: 0 };
const sid = (i: number) => `item${String(i).padStart(12, "0")}`;

const noteInput = (extra: Partial<Omit<NoteItem, "ref">> = {}): ItemInput => ({
  kind: "note",
  ...NOTE_DEFAULTS,
  x: 100,
  y: 100,
  w: 200,
  h: 120,
  text: "Idea",
  color: "blue",
  bold: true,
  titleFontSize: "xl",
  ...extra,
});
const frameInput = (extra: Partial<Omit<FrameItem, "ref">> = {}): ItemInput => ({
  kind: "frame",
  x: 0,
  y: 0,
  w: 800,
  h: 500,
  title: "Start",
  color: "green",
  ...FRAME_DEFAULTS,
  titleAlign: "center",
  ...extra,
});

/* ── packItems (pure) ──────────────────────────────────────────────── */

let refN = 0;
const ref12 = () => `ref${String(refN++).padStart(9, "0")}`;
const noteDraft = (text: string): ItemDraft => {
  const { kind: _, ...rest } = noteInput({ text }) as Extract<ItemInput, { kind: "note" }>;
  return { kind: "note", item: { ref: ref12(), ...rest } };
};
const frameDraft = (title: string): ItemDraft => {
  const { kind: _, ...rest } = frameInput({ title }) as Extract<ItemInput, { kind: "frame" }>;
  return { kind: "frame", item: { ref: ref12(), ...rest } };
};
const flat = (messages: ReturnType<typeof packItems>["messages"]) => messages.flatMap((m) => [...(m.notes ?? []), ...(m.frames ?? [])].map((i) => i.ref));

describe("packItems", () => {
  it("packs by actual size: never over MAX_MESSAGE_BYTES, at most MAX_BATCH_ENTRIES items, every message valid", () => {
    const drafts = Array.from({ length: 120 }, (_, i) => (i % 3 === 0 ? frameDraft("\ud800".repeat(i % 60)) : noteDraft("\ud800".repeat((i * 37) % MAX_NOTE_TEXT))));
    const { messages, tooLarge } = packItems(drafts, ref12);
    expect(tooLarge).toEqual([]);
    expect(messages.length).toBeGreaterThan(1);
    for (const m of messages) {
      expect(messageBytes(m)).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
      expect((m.notes?.length ?? 0) + (m.frames?.length ?? 0)).toBeLessThanOrEqual(MAX_BATCH_ENTRIES);
      expect(clientMessageSchema.safeParse(m).success).toBe(true);
    }
  });

  it("keeps order: every item once, in the order given, and messages fill up before the next starts", () => {
    const drafts = Array.from({ length: 60 }, (_, i) => (i % 4 === 0 ? frameDraft(`F${i}`) : noteDraft(`N${i}`)));
    const { messages } = packItems(drafts, ref12);
    const notes = drafts.filter((d) => d.kind === "note").map((d) => d.item.ref);
    const frames = drafts.filter((d) => d.kind === "frame").map((d) => d.item.ref);
    expect(messages.flatMap((m) => (m.notes ?? []).map((n) => n.ref))).toEqual(notes);
    expect(messages.flatMap((m) => (m.frames ?? []).map((f) => f.ref))).toEqual(frames);
    expect(new Set(flat(messages)).size).toBe(drafts.length);
    // Each message but the last couldn't take the next item.
    for (const [i, m] of messages.slice(0, -1).entries()) {
      const nextRef = flat(messages.slice(i + 1))[0];
      const next = drafts.find((d) => d.item.ref === nextRef)!;
      const grown = next.kind === "note" ? { ...m, notes: [...(m.notes ?? []), next.item] } : { ...m, frames: [...(m.frames ?? []), next.item] };
      expect(messageBytes(grown) > MAX_MESSAGE_BYTES || (grown.notes?.length ?? 0) + (grown.frames?.length ?? 0) > MAX_BATCH_ENTRIES).toBe(true);
    }
  });

  it("small items stop at MAX_BATCH_ENTRIES only if the bytes allow; maximum notes go 2 to a message", () => {
    const worst = Array.from({ length: 5 }, () => noteDraft("\ud800".repeat(MAX_NOTE_TEXT)));
    expect(packItems(worst, ref12).messages.map((m) => m.notes?.length)).toEqual([2, 2, 1]);
    expect(packItems([], ref12)).toEqual({ messages: [], tooLarge: [] });
  });

  it("an item that can't fit even alone is reported, not sent (impossible for valid items at 4 KiB)", () => {
    const big = noteDraft("x".repeat(200));
    const small = frameDraft("");
    const { messages, tooLarge } = packItems([big, small], ref12, 400);
    expect(tooLarge).toEqual([big]);
    expect(flat(messages)).toEqual([small.item.ref]);
  });
});

/* ── RoomSession.addItems ─────────────────────────────────────────── */

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

function session() {
  let socket: FakeSocket | null = null;
  const views: RoomView[] = [];
  const confirmedNotes: [string, string][] = [];
  const confirmedFrames: [string, string][] = [];
  const createSocket: SocketFactory = (_url, handlers) => (socket = new FakeSocket(handlers));
  const s = new RoomSession({
    url: "wss://relay.example.test/ws?room=CODE",
    createSocket,
    checkCode: () => Promise.resolve("valid"),
    onChange: (v) => views.push(v),
    onNoteConfirmed: (local, id) => confirmedNotes.push([local, id]),
    onFrameConfirmed: (local, id) => confirmedFrames.push([local, id]),
  });
  s.join("Alex");
  const sock = () => socket!;
  sock().handlers.onOpen();
  sock().receive({ type: "welcome", protocolVersion: PROTOCOL_VERSION });
  sock().receive({ type: "joined", you: alex, participants: [alex] });
  sock().receive({ type: "snapshot", notes: [] });
  sock().receive({ type: "framesSnapshot", frames: [] });
  const start = sock().sent.length;
  const out = () => sock().sent.slice(start);
  const view = () => views.at(-1)!;
  let next = 0;
  /** The relay's answer to one itemsAdd: everything added, except the refs in `refuse` (with their reason). */
  const answer = (message: Record<string, unknown>, refuse: Record<string, "invalid" | "notes_full" | "frames_full"> = {}) => {
    const notes = (message.notes ?? []) as NoteItem[];
    const frames = (message.frames ?? []) as FrameItem[];
    const refused = [
      ...notes.flatMap((n, index) => (refuse[n.ref] ? [{ kind: "note", index, ref: n.ref, reason: refuse[n.ref] }] : [])),
      ...frames.flatMap((f, index) => (refuse[f.ref] ? [{ kind: "frame", index, ref: f.ref, reason: refuse[f.ref] }] : [])),
    ];
    sock().receive({
      type: "itemsAdded",
      clientRef: message.clientRef,
      notes: notes.filter((n) => !refuse[n.ref]).map(({ ref, ...n }): { ref: string; note: Note } => ({ ref, note: { id: sid(next), ...n, z: next++, rev: 1, authorId: alex.id } })),
      frames: frames.filter((f) => !refuse[f.ref]).map(({ ref, ...f }): { ref: string; frame: Frame } => ({ ref, frame: { id: sid(next++), ...f, rev: 1, authorId: alex.id } })),
      refused,
    });
  };
  return { session: s, sock, out, view, answer, confirmedNotes, confirmedFrames };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("RoomSession.addItems", () => {
  it("shows every item at once with its full content, pending, notes stacked in the order given", () => {
    const t = session();
    const ids = t.session.addItems([noteInput({ text: "One" }), frameInput(), noteInput({ text: "Two", x: BOARD_WIDTH, w: NOTE_MAX_W })]);
    expect(ids).toHaveLength(3);
    expect(ids!.every((id) => id !== null && isLocalId(id))).toBe(true);
    const [one = "", frame = "", two = ""] = ids!.map((id) => id!);
    const board = t.view().board;
    expect(findNote(board, one)?.note).toMatchObject({ text: "One", w: 200, h: 120, color: "blue", bold: true, titleFontSize: "xl", authorId: alex.id });
    expect(findNote(board, two)?.note).toMatchObject({ text: "Two", x: BOARD_WIDTH - NOTE_MAX_W, w: NOTE_MAX_W });
    expect(findNote(board, two)!.note.z).toBeGreaterThan(findNote(board, one)!.note.z);
    expect(findFrame(board, frame)?.frame).toMatchObject({ w: 800, h: 500, title: "Start", titleAlign: "center" });
    expect(findNote(board, one)?.confirmed).toBeNull();
    // One message, the items as shown (clamped), refs unique.
    expect(t.out().map((m) => m.message.type)).toEqual(["itemsAdd"]);
    const sent = t.out()[0]!.message;
    expect((sent.notes as NoteItem[]).map((n) => n.text)).toEqual(["One", "Two"]);
    expect((sent.notes as NoteItem[])[1]).toMatchObject({ x: BOARD_WIDTH - NOTE_MAX_W });
    expect(clientMessageSchema.safeParse(sent).success).toBe(true);
  });

  it("confirmation by ref renames each local id to its server id (onNoteConfirmed, onFrameConfirmed)", () => {
    const t = session();
    const [note, frame] = t.session.addItems([noteInput(), frameInput()])!;
    t.answer(t.out()[0]!.message);
    expect(t.confirmedNotes).toEqual([[note, sid(0)]]);
    expect(t.confirmedFrames).toEqual([[frame, sid(1)]]);
    expect(findNote(t.view().board, sid(0))?.confirmed).not.toBeNull();
    expect(findFrame(t.view().board, sid(1))?.confirmed).not.toBeNull();
    expect(t.view().noteNotice).toBeNull();
  });

  it("packs by size and paces the messages: the first at once, then one every ITEMS_STEP_MS at most", async () => {
    expect(ITEMS_MESSAGES_PER_SECOND).toBeLessThanOrEqual(10);
    expect(ITEMS_STEP_MS).toBe(1000 / ITEMS_MESSAGES_PER_SECOND);
    const t = session();
    t.session.addItems(Array.from({ length: 30 }, () => noteInput({ text: "\ud800".repeat(MAX_NOTE_TEXT) })));
    expect(t.out()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(ITEMS_STEP_MS * 20);
    const times = t.out().map((m) => m.at);
    expect(times).toHaveLength(15);
    for (const at of times) expect(times.filter((x) => x >= at && x < at + 1000).length).toBeLessThanOrEqual(ITEMS_MESSAGES_PER_SECOND);
    expect(t.out().reduce((n, m) => n + (m.message.notes as unknown[]).length, 0)).toBe(30);
  });

  it("refused entries roll back only themselves, and a notice counts them by reason", () => {
    const t = session();
    const [a = "", b = "", c = "", f = ""] = t.session.addItems([noteInput(), noteInput(), noteInput(), frameInput()])!.map((id) => id!);
    const sent = t.out()[0]!.message;
    const refs = (sent.notes as NoteItem[]).map((n) => n.ref);
    const frameRef = (sent.frames as FrameItem[])[0]!.ref;
    t.answer(sent, { [refs[1]!]: "notes_full", [refs[2]!]: "notes_full", [frameRef]: "frames_full" });
    const board = t.view().board;
    expect(findNote(board, a)).toBeUndefined();
    expect(findNote(board, sid(0))).toBeDefined();
    expect(findNote(board, b)).toBeUndefined();
    expect(findNote(board, c)).toBeUndefined();
    expect(findFrame(board, f)).toBeUndefined();
    expect(board.notes).toHaveLength(1);
    expect(t.view().noteNotice).toBe(NOTICES.itemsNotAdded({ notesFull: 2, framesFull: 1, invalid: 0, tooQuick: 0 }));
    expect(t.view().noteNotice).toBe(
      "2 notes weren’t added because the board is full (200 notes). 1 frame wasn’t added because the board has the maximum of 30 frames.",
    );
  });

  it("a whole message refused (nothing added, or too quick) rolls back all its items", async () => {
    const t = session();
    t.session.addItems([noteInput(), noteInput()]);
    const sent = t.out()[0]!.message;
    t.sock().receive({ type: "error", code: "rate_limited", message: "Slow down.", clientRef: sent.clientRef });
    expect(t.view().board.notes).toEqual([]);
    expect(t.view().rateLimited).toBe(true);
    expect(t.view().noteNotice).toBe("2 items weren’t added because that was too quick. Try again.");

    t.session.addItems([frameInput()]);
    await vi.advanceTimersByTimeAsync(ITEMS_STEP_MS);
    const again = t.out()[1]!.message;
    const ref = (again.frames as FrameItem[])[0]!.ref;
    t.sock().receive({ type: "error", code: "frames_full", message: "Nothing was added.", clientRef: again.clientRef, refused: [{ kind: "frame", index: 0, ref, reason: "frames_full" }] });
    expect(t.view().board.frames).toEqual([]);
    expect(t.view().noteNotice).toBe("1 frame wasn’t added because the board has the maximum of 30 frames.");
  });

  it("the notice waits until every message of the call is answered", async () => {
    const t = session();
    t.session.addItems(Array.from({ length: 3 }, () => noteInput({ text: "\ud800".repeat(MAX_NOTE_TEXT) })));
    await vi.advanceTimersByTimeAsync(ITEMS_STEP_MS);
    const [first, second] = t.out().map((m) => m.message);
    t.answer(first!, { [(first!.notes as NoteItem[])[0]!.ref]: "invalid" });
    expect(t.view().noteNotice).toBeNull();
    t.answer(second!);
    expect(t.view().noteNotice).toBe("1 item wasn’t added because the relay refused it.");
  });

  it("text edited, or the item deleted, before it was confirmed: one noteEdit, or a delete, once it is", () => {
    const t = session();
    const [kept, gone] = t.session.addItems([noteInput({ text: "Old" }), noteInput()])!;
    t.session.editNote(kept!, "New");
    t.session.deleteNote(gone!);
    const sent = t.out()[0]!.message;
    expect(t.out()).toHaveLength(1);
    t.answer(sent);
    expect(t.out().slice(1).map((m) => m.message)).toEqual([
      { type: "noteEdit", id: sid(0), text: "New" },
      { type: "noteDelete", id: sid(1) },
    ]);
    expect(t.view().board.notes.map((n) => n.note.text)).toEqual(["New"]);
  });

  it("someone else's itemsAdded adds their items in one update", () => {
    const t = session();
    const note: Note = { id: sid(7), x: 0, y: 0, ...NOTE_DEFAULTS, text: "Theirs", color: "pink", z: 0, rev: 1, authorId: "BBBBBBBBBBBBBBBB" };
    const frame: Frame = { id: sid(8), x: 0, y: 0, w: 640, h: 400, title: "", color: "neutral", ...FRAME_DEFAULTS, rev: 1, authorId: "BBBBBBBBBBBBBBBB" };
    t.sock().receive({ type: "itemsAdded", notes: [{ note }], frames: [{ frame }], refused: [] });
    expect(findNote(t.view().board, sid(7))?.note).toEqual(note);
    expect(findFrame(t.view().board, sid(8))?.frame).toEqual(frame);
  });

  it("a disconnect drops the messages not sent yet (and their items); the one in flight stays shown", async () => {
    const t = session();
    t.session.addItems(Array.from({ length: 6 }, () => noteInput({ text: "\ud800".repeat(MAX_NOTE_TEXT) })));
    expect(t.out()).toHaveLength(1);
    t.sock().handlers.onClose();
    await vi.advanceTimersByTimeAsync(ITEMS_STEP_MS * 10);
    expect(t.out()).toHaveLength(1);
    expect(t.view().board.notes).toHaveLength(2);
  });

  it("does nothing while disconnected; text too long after cleaning isn't added and is counted", () => {
    const t = session();
    const ids = t.session.addItems([noteInput({ text: "x".repeat(MAX_NOTE_TEXT + 1) }), noteInput()]);
    expect(ids?.[0]).toBeNull();
    t.answer(t.out()[0]!.message);
    expect(t.view().noteNotice).toBe("1 item wasn’t added because the relay refused it.");
    t.sock().handlers.onClose();
    expect(t.session.addItems([noteInput()])).toBeNull();
  });
});
