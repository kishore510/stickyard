// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FRAME_DEFAULTS,
  MAX_FRAMES_PER_ROOM,
  MAX_NOTES_PER_ROOM,
  NOTE_DEFAULTS,
  PROTOCOL_VERSION,
  clientMessageSchema,
  type Frame,
  type FrameItem,
  type Note,
  type NoteItem,
  type Participant,
} from "@stickyard/shared";
import { boardShortcut, type ShortcutEvent, type ShortcutState } from "../src/canvas/shortcuts";
import type { SocketFactory, SocketHandlers } from "../src/connection/socket";
import { findFrame } from "../src/frames/board";
import { HISTORY_TEXT } from "../src/history/history";
import { findNote } from "../src/notes/board";
import { ITEMS_STEP_MS, RoomSession, UNDO_TEXT, type RoomView } from "../src/rooms/session";

/*
 * Undo and redo through RoomSession (part 2), against a small fake relay that stores and answers
 * like the Worker: rev + 1 per stored change, broadcasts to everyone, new ids for added items.
 * Sam's changes are made on the relay directly.
 */

const alex: Participant = { id: "AAAAAAAAAAAAAAAA", name: "Alex", colourIndex: 0 };
const sam: Participant = { id: "BBBBBBBBBBBBBBBB", name: "Sam", colourIndex: 1 };
const nid = (i: number) => `note${String(i).padStart(12, "0")}`;
const fid = (i: number) => `frme${String(i).padStart(12, "0")}`;
const note = (i: number, extra: Partial<Note> = {}): Note => ({ id: nid(i), x: 10 * i, y: 20, ...NOTE_DEFAULTS, text: `Note ${i}`, color: "yellow", z: i, rev: 1, authorId: sam.id, ...extra });
const frame = (i: number, extra: Partial<Frame> = {}): Frame => ({ id: fid(i), x: 0, y: 0, w: 640, h: 400, title: `F${i}`, color: "neutral", ...FRAME_DEFAULTS, rev: 1, authorId: sam.id, ...extra });

class Relay {
  notes = new Map<string, Note>();
  frames = new Map<string, Frame>();
  received: Record<string, unknown>[] = [];
  private next = 1000;
  /** Answers are held while paused (a slow relay). */
  paused = false;
  private queue: Record<string, unknown>[] = [];
  handlers: SocketHandlers | null = null;
  constructor(notes: Note[], frames: Frame[]) {
    for (const n of notes) this.notes.set(n.id, n);
    for (const f of frames) this.frames.set(f.id, f);
  }
  private newId = (prefix: string) => `${prefix}${String(this.next++).padStart(12, "0")}`;
  private out(message: unknown) {
    this.handlers?.onMessage(JSON.stringify(message));
  }
  private topZ = () => Math.max(-1, ...[...this.notes.values()].map((n) => n.z)) + 1;
  socket = (handlers: SocketHandlers) => {
    this.handlers = handlers;
    return {
      send: (data: string) => {
        const message = JSON.parse(data) as Record<string, unknown>;
        expect(clientMessageSchema.safeParse(message).success, JSON.stringify(message)).toBe(true);
        this.received.push(message);
        if (this.paused) this.queue.push(message);
        else this.handle(message);
      },
      close: () => {},
    };
  };
  resume() {
    this.paused = false;
    const queued = this.queue;
    this.queue = [];
    for (const m of queued) this.handle(m);
  }
  /** Sam stores a change to a note: broadcast like the Worker. */
  samEdit(id: string, change: Partial<Note>) {
    const current = this.notes.get(id)!;
    const n = { ...current, ...change, rev: current.rev + 1 };
    this.notes.set(id, n);
    this.out({ type: "noteUpdated", note: n });
  }
  private handle(m: Record<string, unknown>) {
    switch (m.type) {
      case "hello":
        return this.out({ type: "welcome", protocolVersion: PROTOCOL_VERSION });
      case "join":
        this.out({ type: "joined", you: alex, participants: [alex, sam] });
        this.out({ type: "snapshot", notes: [...this.notes.values()] });
        return this.out({ type: "framesSnapshot", frames: [...this.frames.values()] });
      case "noteMove": {
        const c = this.notes.get(m.id as string);
        if (!c || !m.final) return;
        const n = c.x !== m.x || c.y !== m.y ? { ...c, x: m.x as number, y: m.y as number, rev: c.rev + 1 } : c;
        this.notes.set(n.id, n);
        return this.out({ type: "noteMoved", id: n.id, x: n.x, y: n.y, rev: n.rev, final: true });
      }
      case "noteResize": {
        const c = this.notes.get(m.id as string);
        if (!c || !m.final) return;
        const n = { ...c, x: m.x as number, y: m.y as number, w: m.w as number, h: m.h as number, rev: c.rev + 1 };
        this.notes.set(n.id, n);
        return this.out({ type: "noteResized", id: n.id, x: n.x, y: n.y, w: n.w, h: n.h, rev: n.rev, final: true });
      }
      case "noteEdit": {
        const c = this.notes.get(m.id as string);
        if (!c) return;
        const { type: _, id: __, ...change } = m;
        const next = { ...c, ...change } as Note;
        if (JSON.stringify(next) === JSON.stringify(c)) return;
        const n = { ...next, rev: c.rev + 1 };
        this.notes.set(n.id, n);
        return this.out({ type: "noteUpdated", note: n });
      }
      case "noteDelete":
        if (!this.notes.delete(m.id as string)) return;
        return this.out({ type: "noteDeleted", id: m.id });
      case "noteBatch": {
        if (!m.final) return;
        const results: unknown[] = [];
        for (const op of m.ops as { op: string; id: string; x: number; y: number; w: number; h: number }[]) {
          const c = this.notes.get(op.id);
          if (!c) continue;
          if (op.op === "delete") {
            this.notes.delete(op.id);
            results.push({ type: "noteDeleted", id: op.id });
            continue;
          }
          const rect = op.op === "move" ? { x: op.x, y: op.y, w: c.w, h: c.h } : { x: op.x, y: op.y, w: op.w, h: op.h };
          const changed = rect.x !== c.x || rect.y !== c.y || rect.w !== c.w || rect.h !== c.h;
          const n = changed ? { ...c, ...rect, rev: c.rev + 1 } : c;
          this.notes.set(n.id, n);
          results.push(op.op === "move" ? { type: "noteMoved", id: n.id, x: n.x, y: n.y, rev: n.rev, final: true } : { type: "noteResized", id: n.id, x: n.x, y: n.y, w: n.w, h: n.h, rev: n.rev, final: true });
        }
        return this.out({ type: "notesBatchApplied", results, final: true });
      }
      case "noteAdd": {
        const n: Note = { id: this.newId("note"), x: m.x as number, y: m.y as number, ...NOTE_DEFAULTS, text: m.text as string, color: m.color as Note["color"], z: this.topZ(), rev: 1, authorId: alex.id };
        this.notes.set(n.id, n);
        return this.out({ type: "noteAdded", note: n, clientRef: m.clientRef });
      }
      case "notesOrder": {
        const results = (m.ids as string[]).flatMap((id) => {
          const c = this.notes.get(id);
          if (!c) return [];
          const n = { ...c, z: m.action === "front" ? this.topZ() : Math.min(...[...this.notes.values()].map((x) => x.z)) - 1, rev: c.rev + 1 };
          this.notes.set(id, n);
          return [{ id, z: n.z, rev: n.rev }];
        });
        return this.out({ type: "notesOrdered", results });
      }
      case "itemsAdd": {
        const notes = ((m.notes ?? []) as NoteItem[]).map(({ ref, ...item }) => {
          const n: Note = { id: this.newId("note"), ...item, z: this.topZ(), rev: 1, authorId: alex.id };
          this.notes.set(n.id, n);
          return { ref, note: n };
        });
        const frames = ((m.frames ?? []) as FrameItem[]).map(({ ref, ...item }) => {
          const f: Frame = { id: this.newId("frme"), ...item, rev: 1, authorId: alex.id };
          this.frames.set(f.id, f);
          return { ref, frame: f };
        });
        return this.out({ type: "itemsAdded", clientRef: m.clientRef, notes, frames, refused: [] });
      }
      case "frameAdd": {
        const f: Frame = { id: this.newId("frme"), x: m.x as number, y: m.y as number, w: 640, h: 400, title: m.title as string, color: m.color as Frame["color"], ...FRAME_DEFAULTS, rev: 1, authorId: alex.id };
        this.frames.set(f.id, f);
        return this.out({ type: "frameAdded", frame: f, clientRef: m.clientRef });
      }
      case "frameEdit": {
        const c = this.frames.get(m.id as string);
        if (!c) return;
        const { type: _, id: __, ...change } = m;
        const f = { ...c, ...change, rev: c.rev + 1 } as Frame;
        this.frames.set(f.id, f);
        return this.out({ type: "frameUpdated", frame: f });
      }
      case "frameMove": {
        const c = this.frames.get(m.id as string);
        if (!c || !m.final) return;
        const dx = (m.x as number) - c.x;
        const dy = (m.y as number) - c.y;
        const f = dx || dy ? { ...c, x: c.x + dx, y: c.y + dy, rev: c.rev + 1 } : c;
        this.frames.set(f.id, f);
        const carried = ((m.noteIds ?? []) as string[]).flatMap((id) => {
          const n = this.notes.get(id);
          if (!n) return [];
          const moved = dx || dy ? { ...n, x: n.x + dx, y: n.y + dy, rev: n.rev + 1 } : n;
          this.notes.set(id, moved);
          return [{ id, x: moved.x, y: moved.y, rev: moved.rev }];
        });
        return this.out({ type: "frameMoved", id: f.id, x: f.x, y: f.y, rev: f.rev, final: true, ...(carried.length ? { notes: carried } : {}) });
      }
      case "frameResize": {
        const c = this.frames.get(m.id as string);
        if (!c || !m.final) return;
        const f = { ...c, x: m.x as number, y: m.y as number, w: m.w as number, h: m.h as number, rev: c.rev + 1 };
        this.frames.set(f.id, f);
        return this.out({ type: "frameResized", id: f.id, x: f.x, y: f.y, w: f.w, h: f.h, rev: f.rev, final: true });
      }
      case "frameDelete":
        if (!this.frames.delete(m.id as string)) return;
        return this.out({ type: "frameDeleted", id: m.id });
    }
  }
}

function room(notes: Note[] = [], frames: Frame[] = []) {
  const relay = new Relay(notes, frames);
  const views: RoomView[] = [];
  const createSocket: SocketFactory = (_url, handlers) => relay.socket(handlers);
  const session = new RoomSession({ url: "wss://relay.example.test/ws?room=CODE", createSocket, checkCode: () => Promise.resolve("valid"), onChange: (v) => views.push(v) });
  session.join("Alex");
  relay.handlers!.onOpen();
  const view = () => views.at(-1)!;
  const sent = (type: string) => relay.received.filter((m) => m.type === type);
  const shown = (id: string) => findNote(view().board, id)?.note;
  return { session, relay, view, sent, shown };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("undo and redo, each action kind (do, undo, redo)", () => {
  it("a drag (one note): undo moves it back with a final batch move, redo moves it again", () => {
    const t = room([note(1)]);
    t.session.startDrag(nid(1));
    t.session.moveNote(nid(1), 300, 400, true);
    expect(t.view().history.undo).toBeNull();
    t.session.undo();
    expect(t.relay.notes.get(nid(1))).toMatchObject({ x: 10, y: 20 });
    expect(t.shown(nid(1))).toMatchObject({ x: 10, y: 20 });
    t.session.redo();
    expect(t.relay.notes.get(nid(1))).toMatchObject({ x: 300, y: 400 });
  });

  it("a group move, a resize, the Width field and arrange are one step each", () => {
    const t = room([note(1), note(2)]);
    t.session.startGroupDrag([nid(1), nid(2)]);
    t.session.moveGroup([{ id: nid(1), x: 100, y: 100 }, { id: nid(2), x: 200, y: 100 }], true);
    t.session.startResize(nid(1));
    t.session.resizeNote(nid(1), { x: 100, y: 100, w: 300, h: 300 }, true);
    vi.advanceTimersByTime(1000);
    t.session.setNoteSize(nid(2), 250, 250);
    vi.advanceTimersByTime(1000);
    t.session.applyRects([{ id: nid(1), x: 0, y: 0, w: 300, h: 300 }]);
    t.session.undo();
    expect(t.relay.notes.get(nid(1))).toMatchObject({ x: 100, y: 100, w: 300 });
    t.session.undo();
    expect(t.relay.notes.get(nid(2))).toMatchObject({ w: 160 });
    t.session.undo();
    expect(t.relay.notes.get(nid(1))).toMatchObject({ w: 160, h: 160 });
    t.session.undo();
    expect([t.relay.notes.get(nid(1))!.x, t.relay.notes.get(nid(2))!.x]).toEqual([10, 20]);
    expect(t.view().history.undo).toBe(HISTORY_TEXT.nothingToUndo);
  });

  it("arrow-key moves committed within 500 ms of each other are one step", () => {
    const t = room([note(1)]);
    t.session.moveNote(nid(1), 20, 20, false);
    t.session.moveNote(nid(1), 20, 20, true);
    vi.advanceTimersByTime(450);
    t.session.moveNote(nid(1), 30, 20, false);
    t.session.moveNote(nid(1), 30, 20, true);
    t.session.undo();
    expect(t.relay.notes.get(nid(1))).toMatchObject({ x: 10 });
    expect(t.view().history.undo).toBe(HISTORY_TEXT.nothingToUndo);
  });

  it("text edits and style changes: noteEdit with the previous values, only the fields that changed", () => {
    const t = room([note(1)]);
    t.session.editNote(nid(1), "New text");
    t.session.styleNote(nid(1), { color: "pink", bold: true });
    t.session.undo();
    expect(t.sent("noteEdit").at(-1)).toEqual({ type: "noteEdit", id: nid(1), color: "yellow", bold: false });
    t.session.undo();
    expect(t.sent("noteEdit").at(-1)).toEqual({ type: "noteEdit", id: nid(1), text: "Note 1" });
    t.session.redo();
    t.session.redo();
    expect(t.relay.notes.get(nid(1))).toMatchObject({ text: "New text", color: "pink", bold: true });
  });

  it("a frame drag carrying notes: undo puts the frame (frameMove, alone) and its notes (batch) back", () => {
    const t = room([note(1, { x: 100, y: 100 })], [frame(1)]);
    t.session.startFrameDrag(fid(1), true);
    t.session.moveFrame(fid(1), 200, 150, true);
    expect(t.relay.notes.get(nid(1))).toMatchObject({ x: 300, y: 250 });
    t.session.undo();
    expect(t.sent("frameMove").at(-1)).toEqual({ type: "frameMove", id: fid(1), x: 0, y: 0, final: true });
    expect(t.relay.frames.get(fid(1))).toMatchObject({ x: 0, y: 0 });
    expect(t.relay.notes.get(nid(1))).toMatchObject({ x: 100, y: 100 });
    t.session.redo();
    expect(t.relay.notes.get(nid(1))).toMatchObject({ x: 300, y: 250 });
  });

  it("frame resize and frame edit", () => {
    const t = room([], [frame(1)]);
    t.session.setFrameSize(fid(1), 900, 600);
    t.session.editFrame(fid(1), { title: "Retro", color: "green" });
    t.session.undo();
    expect(t.sent("frameEdit").at(-1)).toEqual({ type: "frameEdit", id: fid(1), title: "F1", color: "neutral" });
    t.session.undo();
    expect(t.relay.frames.get(fid(1))).toMatchObject({ w: 640, h: 400 });
    t.session.redo();
    t.session.redo();
    expect(t.relay.frames.get(fid(1))).toMatchObject({ w: 900, h: 600, title: "Retro", color: "green" });
  });

  it("add note: undo deletes it; redo adds it back as a new note (new id, me as author)", () => {
    const t = room();
    t.session.addNote({ x: 50, y: 50, color: "green" });
    const [added] = [...t.relay.notes.values()];
    t.session.editNote(added!.id, "Typed");
    t.session.undo();
    t.session.undo();
    expect(t.relay.notes.size).toBe(0);
    t.session.redo();
    const [back] = [...t.relay.notes.values()];
    expect(back).toMatchObject({ text: "", color: "green", authorId: alex.id });
    expect(back!.id).not.toBe(added!.id);
    t.session.redo();
    expect(t.relay.notes.get(back!.id)!.text).toBe("Typed");
  });

  it("add frame, Duplicate and a template: undo removes what they made", () => {
    const t = room([note(1)], [frame(1)]);
    t.session.addFrame({ x: 0, y: 0, color: "blue" });
    t.session.duplicateNotes([nid(1)]);
    vi.advanceTimersByTime(ITEMS_STEP_MS);
    t.session.applyTemplate([{ x: 0, y: 500, w: 640, h: 400, title: "Went well", color: "green", style: FRAME_DEFAULTS }]);
    vi.advanceTimersByTime(ITEMS_STEP_MS);
    expect(t.relay.frames.size).toBe(3);
    expect(t.relay.notes.size).toBe(2);
    t.session.undo();
    expect(t.relay.frames.size).toBe(2);
    t.session.undo();
    expect(t.relay.notes.size).toBe(1);
    t.session.undo();
    expect(t.relay.frames.size).toBe(1);
  });

  it("delete notes and a frame: undo restores them with their content as new items; notes keep their stacking order", () => {
    const t = room([note(1, { z: 5, text: "top", color: "pink" }), note(2, { z: -3, text: "bottom" }), note(3, { z: 0 })], [frame(1, { title: "Keep" })]);
    t.session.deleteNotes([nid(1), nid(2)]);
    t.session.deleteFrame(fid(1));
    t.session.undo();
    vi.advanceTimersByTime(ITEMS_STEP_MS * 5);
    expect(t.relay.frames.size).toBe(1);
    expect([...t.relay.frames.values()][0]).toMatchObject({ title: "Keep", authorId: alex.id });
    t.session.undo();
    vi.advanceTimersByTime(ITEMS_STEP_MS * 5);
    const restored = [...t.relay.notes.values()].filter((n) => n.authorId === alex.id).sort((a, b) => a.z - b.z);
    expect(restored.map((n) => n.text)).toEqual(["bottom", "top"]);
    expect(restored[1]).toMatchObject({ color: "pink" });
    t.session.redo();
    expect(t.relay.notes.size).toBe(1);
  });
});

describe("undo never overwrites someone else's change", () => {
  it("skips what Sam changed since, applies the rest, and says how many were left", () => {
    const t = room([note(1), note(2)]);
    t.session.startGroupDrag([nid(1), nid(2)]);
    t.session.moveGroup([{ id: nid(1), x: 100, y: 100 }, { id: nid(2), x: 200, y: 100 }], true);
    t.relay.samEdit(nid(2), { text: "Sam's" });
    t.session.undo();
    expect(t.relay.notes.get(nid(1))).toMatchObject({ x: 10, y: 20 });
    expect(t.relay.notes.get(nid(2))).toMatchObject({ x: 200, text: "Sam's" });
    expect(t.view().historyReport?.text).toBe(HISTORY_TEXT.conflicts(1));
  });

  it("delete, undo (a new note), then undo the move before it: the restored note moves back", () => {
    const t = room([note(1)]);
    t.session.moveNote(nid(1), 400, 20, true);
    vi.advanceTimersByTime(1000);
    t.session.deleteNote(nid(1));
    t.session.undo();
    vi.advanceTimersByTime(ITEMS_STEP_MS);
    const [restored] = [...t.relay.notes.values()];
    expect(restored).toMatchObject({ x: 400 });
    t.session.undo();
    expect(t.relay.notes.get(restored!.id)).toMatchObject({ x: 10 });
  });
});

describe("order changes", () => {
  it("aren't undone: undo says so, and the next undo is the action before", () => {
    const t = room([note(1), note(2)]);
    t.session.moveNote(nid(1), 300, 20, true);
    t.session.orderNotes([nid(1)], "back");
    t.session.undo();
    expect(t.view().historyReport?.text).toBe(UNDO_TEXT.order);
    expect(UNDO_TEXT.order).toBe("Order changes can’t be undone.");
    expect(t.relay.notes.get(nid(1))).toMatchObject({ x: 300 });
    t.session.undo();
    expect(t.relay.notes.get(nid(1))).toMatchObject({ x: 10 });
  });
});

describe("when history is cleared or blocked", () => {
  it("a lost connection clears both stacks (ids and revs can't be trusted)", () => {
    const t = room([note(1)]);
    t.session.moveNote(nid(1), 300, 20, true);
    t.relay.handlers!.onClose();
    expect(t.view().history).toEqual({ undo: UNDO_TEXT.offline, redo: UNDO_TEXT.offline });
  });

  it("a fresh snapshot (resync) clears both stacks", () => {
    const t = room([note(1)]);
    t.session.moveNote(nid(1), 300, 20, true);
    t.relay.handlers!.onMessage(JSON.stringify({ type: "snapshot", notes: [...t.relay.notes.values()] }));
    expect(t.view().history.undo).toBe(HISTORY_TEXT.nothingToUndo);
  });

  it("not undoable until the relay has confirmed it; an unconfirmed add isn't either", () => {
    const t = room([note(1)]);
    t.relay.paused = true;
    t.session.moveNote(nid(1), 300, 20, true);
    expect(t.view().history.undo).toBe(HISTORY_TEXT.unsaved);
    t.relay.resume();
    expect(t.view().history.undo).toBeNull();
    t.relay.paused = true;
    t.session.addNote({ x: 0, y: 0, color: "pink" });
    expect(t.view().history.undo).toBe(HISTORY_TEXT.unsaved);
  });

  it("a new action clears redo", () => {
    const t = room([note(1)]);
    t.session.moveNote(nid(1), 300, 20, true);
    t.session.undo();
    expect(t.view().history.redo).toBeNull();
    t.session.editNote(nid(1), "x");
    expect(t.view().history.redo).toBe(HISTORY_TEXT.nothingToRedo);
  });
});

describe("paced restores", () => {
  const fullBoard = () =>
    room(
      Array.from({ length: MAX_NOTES_PER_ROOM }, (_, i) => note(i, { x: (i % 16) * 190, y: Math.floor(i / 16) * 150, text: `N${i}`, z: i })),
      Array.from({ length: MAX_FRAMES_PER_ROOM }, (_, i) => frame(i)),
    );

  async function clearAll(t: ReturnType<typeof room>) {
    t.session.deleteNotes([...t.relay.notes.keys()]);
    for (const id of [...t.relay.frames.keys()]) t.session.deleteFrame(id);
    await vi.advanceTimersByTimeAsync(0);
  }

  it("200 notes: paced itemsAdd, a running status, undo/redo/duplicate blocked meanwhile, then everything back in order", async () => {
    const t = fullBoard();
    t.session.deleteNotes([...t.relay.notes.keys()]);
    expect(t.relay.notes.size).toBe(0);
    t.relay.paused = true;
    t.session.undo();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.view().historyReport?.text).toMatch(/^Restoring 0 of 200…$/);
    expect(t.view().history.undo).toBe(UNDO_TEXT.busy);
    expect(t.view().history.redo).toBe(UNDO_TEXT.busy);
    expect(t.view().adding).toBe(true);
    t.relay.resume();
    await vi.advanceTimersByTimeAsync(ITEMS_STEP_MS * 3);
    expect(t.view().historyReport?.text).toMatch(/^Restoring \d+ of 200…$/);
    await vi.advanceTimersByTimeAsync(ITEMS_STEP_MS * 200);
    expect(t.relay.notes.size).toBe(200);
    expect(t.view().historyReport).toEqual({ text: "Restored 200 items.", partial: false });
    const adds = t.sent("itemsAdd");
    for (let i = 1; i < adds.length; i++) expect(t.relay.received.indexOf(adds[i]!)).toBeGreaterThan(t.relay.received.indexOf(adds[i - 1]!));
    const texts = [...t.relay.notes.values()].sort((a, b) => a.z - b.z).map((n) => n.text);
    expect(texts).toEqual(Array.from({ length: 200 }, (_, i) => `N${i}`));
    expect(t.relay.frames.size).toBe(MAX_FRAMES_PER_ROOM);
  });

  it("the whole board (200 notes + 30 frames) deleted in one go comes back in one undo", async () => {
    const t = fullBoard();
    await clearAll(t);
    expect(t.relay.notes.size + t.relay.frames.size).toBe(0);
    // Deleted as 31 steps: frames one by one, notes in one. Undo them all.
    for (let i = 0; i < 31; i++) {
      t.session.undo();
      await vi.advanceTimersByTimeAsync(ITEMS_STEP_MS * 200);
    }
    expect(t.relay.notes.size).toBe(200);
    expect(t.relay.frames.size).toBe(30);
  });

  it("a disconnect mid-restore ends it as partial: says how many came back, retries nothing, clears the stacks", async () => {
    const t = fullBoard();
    t.session.deleteNotes([...t.relay.notes.keys()]);
    t.session.undo();
    await vi.advanceTimersByTimeAsync(ITEMS_STEP_MS * 3);
    const back = t.relay.notes.size;
    expect(back).toBeGreaterThan(0);
    expect(back).toBeLessThan(200);
    t.relay.handlers!.onClose();
    const sentBefore = t.relay.received.length;
    await vi.advanceTimersByTimeAsync(ITEMS_STEP_MS * 200);
    expect(t.relay.received.length).toBe(sentBefore);
    expect(t.view().historyReport).toEqual({ text: `Restored ${back} of 200 items. The connection was lost, so the rest weren’t restored.`, partial: true });
    expect(t.view().history.undo).toBe(UNDO_TEXT.offline);
  });
});

describe("the undo and redo shortcuts", () => {
  let board: HTMLElement;
  beforeEach(() => {
    document.body.innerHTML = '<section data-board><div class="pane"></div><textarea data-inline="title"></textarea><input /></section>';
    board = document.querySelector("[data-board]")!;
  });
  const ev = (extra: Partial<ShortcutEvent>): ShortcutEvent => ({ key: "z", target: document.body, defaultPrevented: false, ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, ...extra });
  const st: ShortcutState = { multi: true, modal: false, board: document.body };

  it("Ctrl/Cmd+Z undoes; Ctrl/Cmd+Shift+Z and Ctrl+Y redo, on the board", () => {
    const state = { ...st, board };
    expect(boardShortcut(ev({}), state)).toBe("undo");
    expect(boardShortcut(ev({ ctrlKey: false, metaKey: true }), state)).toBe("undo");
    expect(boardShortcut(ev({ shiftKey: true, key: "Z" }), state)).toBe("redo");
    expect(boardShortcut(ev({ metaKey: true, ctrlKey: false, shiftKey: true }), state)).toBe("redo");
    expect(boardShortcut(ev({ key: "y" }), state)).toBe("redo");
    expect(boardShortcut(ev({ target: board.querySelector(".pane") }), state)).toBe("undo");
  });

  it("never in text fields or inline editing (the browser's own text undo), a modal, or on phones", () => {
    const state = { ...st, board };
    expect(boardShortcut(ev({ target: board.querySelector("textarea") }), state)).toBeNull();
    expect(boardShortcut(ev({ target: board.querySelector("input") }), state)).toBeNull();
    expect(boardShortcut(ev({ key: "y", target: board.querySelector("input") }), state)).toBeNull();
    expect(boardShortcut(ev({}), { ...state, modal: true })).toBeNull();
    expect(boardShortcut(ev({}), { ...state, multi: false })).toBeNull();
    expect(boardShortcut(ev({ altKey: true }), state)).toBeNull();
    expect(boardShortcut(ev({ key: "y", metaKey: true, ctrlKey: false }), state)).toBeNull();
  });
});

describe("undo while disconnected", () => {
  it("does nothing and the reason says why", () => {
    const t = room([note(1)]);
    t.relay.handlers!.onClose();
    t.session.undo();
    expect(t.relay.received.filter((m) => m.type === "noteBatch")).toEqual([]);
    expect(t.view().history.undo).toBe(UNDO_TEXT.offline);
    expect(findFrame(t.view().board, "x")).toBeUndefined();
  });
});
