import { expect } from "vitest";
import {
  FRAME_DEFAULTS,
  NOTE_DEFAULTS,
  PROTOCOL_VERSION,
  clientMessageSchema,
  type Frame,
  type FrameItem,
  type Note,
  type NoteItem,
  type Participant,
} from "@stickyard/shared";
import type { SocketFactory, SocketHandlers } from "../../src/connection/socket";
import { findNote } from "../../src/notes/board";
import { RoomSession, type RoomView, type SessionOptions } from "../../src/rooms/session";

/*
 * A small fake relay for session tests: stores and answers like the Worker (rev + 1 per stored
 * change, broadcasts to everyone, new ids for added items). Sam's changes are made on it directly.
 * Refusals can be switched on per batch or per frame.
 */

export const alex: Participant = { id: "AAAAAAAAAAAAAAAA", name: "Alex", colourIndex: 0, host: false };
export const sam: Participant = { id: "BBBBBBBBBBBBBBBB", name: "Sam", colourIndex: 1, host: false };
export const nid = (i: number) => `note${String(i).padStart(12, "0")}`;
export const fid = (i: number) => `frme${String(i).padStart(12, "0")}`;
export const note = (i: number, extra: Partial<Note> = {}): Note => ({ id: nid(i), x: 10 * i, y: 20, ...NOTE_DEFAULTS, text: `Note ${i}`, color: "yellow", z: i, rev: 1, authorId: sam.id, ...extra });
export const frame = (i: number, extra: Partial<Frame> = {}): Frame => ({ id: fid(i), x: 0, y: 0, w: 640, h: 400, title: `F${i}`, color: "neutral", ...FRAME_DEFAULTS, rev: 1, authorId: sam.id, ...extra });

export class Relay {
  notes = new Map<string, Note>();
  frames = new Map<string, Frame>();
  received: Record<string, unknown>[] = [];
  private next = 1000;
  /** Answers are held while paused (a slow relay). */
  paused = false;
  private queue: Record<string, unknown>[] = [];
  handlers: SocketHandlers | null = null;
  /** Final noteBatch messages (counted from 0) to refuse as too quick. */
  refuseBatches = new Set<number>();
  private batches = 0;
  /** Frames whose delete is refused. */
  refuseFrameDeletes = new Set<string>();
  /** Who joins (the name comes from the join message), and who else is in the room. */
  you: Participant = alex;
  others: Participant[] = [sam];
  /** An error code to answer the next joins with (room_full, version_mismatch...). */
  joinError: string | null = null;
  /** The protocol version the welcome claims. */
  welcomeVersion = PROTOCOL_VERSION;
  /** Hold the framesSnapshot until sendFrames() (a late frames message). */
  holdFrames = false;
  /** Sockets opened so far, and how many of them this page closed. */
  sockets = 0;
  closes = 0;
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
    this.sockets++;
    const mine = handlers;
    return {
      send: (data: string) => {
        const message = JSON.parse(data) as Record<string, unknown>;
        expect(clientMessageSchema.safeParse(message).success, JSON.stringify(message)).toBe(true);
        // A closed socket's sends go nowhere.
        if (this.handlers !== mine) return;
        this.received.push(message);
        if (this.paused) this.queue.push(message);
        else this.handle(message);
      },
      close: () => {
        this.closes++;
      },
    };
  };
  /** The socket opens (the relay accepted the upgrade). */
  open() {
    this.handlers?.onOpen();
  }
  /** The connection drops: answers not sent yet are lost. */
  drop() {
    this.queue = [];
    const h = this.handlers;
    this.handlers = null;
    h?.onClose();
  }
  /** The relay closes the socket with a close code (4410: the room has expired). */
  closeWith(code: number) {
    this.queue = [];
    const h = this.handlers;
    this.handlers = null;
    h?.onClose(code);
  }
  /** A socket that never opens (the upgrade failed). */
  failOpen() {
    this.drop();
  }
  /** Sends the held framesSnapshot. */
  sendFrames() {
    this.out({ type: "framesSnapshot", frames: [...this.frames.values()] });
  }
  /** Someone else joins or leaves. */
  arrive(p: Participant) {
    this.others = [...this.others.filter((o) => o.id !== p.id), p];
    this.out({ type: "participant_joined", participant: p });
  }
  leave(id: string) {
    this.others = this.others.filter((o) => o.id !== id);
    this.out({ type: "participant_left", id });
  }
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
        return this.out({ type: "welcome", protocolVersion: this.welcomeVersion });
      case "join": {
        if (this.joinError) return this.out({ type: "error", code: this.joinError, message: "No." });
        const you = { ...this.you, name: m.name as string };
        this.out({ type: "joined", you, participants: [you, ...this.others], locked: false, timer: null });
        this.out({ type: "snapshot", notes: [...this.notes.values()] });
        if (this.holdFrames) return;
        return this.out({ type: "framesSnapshot", frames: [...this.frames.values()] });
      }
      case "say":
        return this.out({ type: "echo", from: this.you.id, text: m.text });
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
        if (this.refuseBatches.has(this.batches++)) {
          return this.out({ type: "error", code: "rate_limited", message: "Too quick.", noteIds: (m.ops as { id: string }[]).map((o) => o.id) });
        }
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
        if (this.refuseFrameDeletes.has(m.id as string)) return this.out({ type: "error", code: "bad_message", message: "No.", frameId: m.id });
        if (!this.frames.delete(m.id as string)) return;
        return this.out({ type: "frameDeleted", id: m.id });
    }
  }
}

export function room(notes: Note[] = [], frames: Frame[] = [], options: Partial<SessionOptions> = {}) {
  const relay = new Relay(notes, frames);
  const views: RoomView[] = [];
  const createSocket: SocketFactory = (_url, handlers) => relay.socket(handlers);
  const session = new RoomSession({
    url: "wss://relay.example.test/ws?room=CODE",
    createSocket,
    checkCode: () => Promise.resolve("valid"),
    onChange: (v) => views.push(v),
    ...options,
  });
  session.join("Alex");
  relay.handlers!.onOpen();
  const view = () => views.at(-1)!;
  const sent = (type: string) => relay.received.filter((m) => m.type === type);
  const shown = (id: string) => findNote(view().board, id)?.note;
  return { session, relay, view, views, sent, shown };
}
