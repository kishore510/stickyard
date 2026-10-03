import {
  MAX_NOTES_PER_ROOM,
  MAX_SERVER_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  cleanName,
  cleanNoteText,
  cleanText,
  encodeMessage,
  parseMessage,
  serverMessageSchema,
  type ClientMessage,
  type NoteColor,
  type NoteRect,
  type Participant,
  type ServerMessage,
} from "@stickyard/shared";
import type { SocketFactory, SocketLike } from "../connection/socket";
import {
  EMPTY_BOARD,
  addLocal,
  applyAdded,
  applyDeleted,
  applyMoved,
  applyResized,
  applySnapshot,
  applyUpdated,
  deleteLocal,
  editLocal,
  findNote,
  isLocalId,
  localId,
  moveLocal,
  rejectAdd,
  resizeLocal,
  rollback,
  setDraft,
  setDragging,
  setResizing,
  styleChanges,
  styleLocal,
  type Board,
  type StylePatch,
} from "../notes/board";
import type { CodeCheck } from "./api";

/*
 * One visit to a room: connect, hello, join, then follow participants, echoes and notes.
 * Everything the server sends is validated against the shared schema; anything this page
 * can't understand means it is out of date ("reload"). Names and text are kept as plain
 * strings and only ever rendered as text.
 *
 * Notes are optimistic: local changes show at once and roll back if the server refuses them
 * (see notes/board.ts). Editing needs a live connection; there's no offline queue yet.
 */

export type RoomStatus = "idle" | "connecting" | "joined" | "invalid" | "full" | "reload" | "unreachable" | "disconnected";

export interface EchoEntry {
  key: number;
  from: string;
  name: string;
  colourIndex: number;
  text: string;
  /** When it arrived here (ms since the epoch, this device's clock). */
  at: number;
}

export interface RoomView {
  status: RoomStatus;
  you: Participant | null;
  participants: Participant[];
  messages: EchoEntry[];
  /** The last name was refused (locally or by the server). */
  nameError: boolean;
  /** The server said we're sending too fast. Cleared by our next accepted message. */
  rateLimited: boolean;
  /** For an aria-live region: "<name> joined" / "<name> left". */
  announcement: string;
  board: Board;
  /** A short message about a refused note change, until the next note action. */
  noteNotice: string | null;
  /** The board snapshot has arrived (the first view can be fitted to the notes). */
  synced: boolean;
  /** Everyone seen in this visit (including people who have left), by id: note authors' names. */
  people: ReadonlyMap<string, Participant>;
}

export const INITIAL_VIEW: RoomView = {
  status: "idle",
  you: null,
  participants: [],
  messages: [],
  nameError: false,
  rateLimited: false,
  announcement: "",
  board: EMPTY_BOARD,
  noteNotice: null,
  synced: false,
  people: new Map(),
};

export const JOIN_TIMEOUT_MS = 10_000;
/** Echoes kept on screen. */
export const MAX_MESSAGES = 100;
/** Drag updates are sent at most this often per note (about 20 a second), then once on drop. */
export const MOVE_INTERVAL_MS = 50;
/** Resize updates likewise: at most about 20 a second per note, then once on release. */
export const RESIZE_INTERVAL_MS = 50;

export const NOTICES = {
  full: `The board is full (${MAX_NOTES_PER_ROOM} notes). Delete a note to add another.`,
  tooQuick: "That change was too quick and wasn’t saved. Try again.",
  refused: "That change wasn’t saved. Try again.",
  deletedWhileEditing: "Someone else deleted the note you were editing.",
} as const;

const randomRef = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_");
};

interface Throttle {
  last: number;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export interface SessionOptions {
  /** The room's WebSocket URL (with the code). */
  url: string;
  createSocket: SocketFactory;
  /** Asked when the socket fails before opening: was it the code, or the network? */
  checkCode(): Promise<CodeCheck>;
  onChange(view: RoomView): void;
  /** A note added here got its server id (selection and edit requests follow it). */
  onNoteConfirmed?(localId: string, id: string): void;
}

export class RoomSession {
  private view: RoomView = INITIAL_VIEW;
  private socket: SocketLike | null = null;
  private opened = false;
  private welcomed = false;
  private stopped = false;
  private pendingName: string | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private nextKey = 0;
  /** Everyone seen in this visit, so echoes keep their sender's name after they leave. */
  private readonly known = new Map<string, Participant>();
  /** Per note being moved: when a move was last sent, and the pending trailing send. */
  private readonly moves = new Map<string, Throttle>();
  /** The same for resizes. */
  private readonly resizes = new Map<string, Throttle>();
  /** Adds deleted here before the server confirmed them: delete them once it does. */
  private readonly abandoned = new Set<string>();

  constructor(private readonly options: SessionOptions) {}

  /** Joins with `name`, connecting first if needed. Refuses a name that is empty after cleaning. */
  join(name: string): void {
    if (this.stopped) return;
    const clean = cleanName(name);
    if (clean === null) return this.update({ nameError: true });
    this.pendingName = clean;
    this.update({ status: "connecting", nameError: false });
    this.startTimer();
    if (this.socket) {
      if (this.welcomed) this.send({ type: "join", name: clean });
      return;
    }
    try {
      this.socket = this.options.createSocket(this.options.url, {
        onOpen: () => this.onOpen(),
        onMessage: (data) => this.onMessage(data),
        onClose: () => this.onClose(),
        onError: () => {
          // A close event always follows.
        },
      });
    } catch {
      this.finish("unreachable");
    }
  }

  /** Sends text to the room. False if not joined or the text is empty after cleaning. */
  say(text: string): boolean {
    if (this.stopped || this.view.status !== "joined") return false;
    const clean = cleanText(text);
    if (clean === null) return false;
    this.send({ type: "say", text: clean });
    return true;
  }

  private get live(): boolean {
    return !this.stopped && this.view.status === "joined";
  }

  /** Adds an empty note (or one with `text`). Its temporary id, or null if not connected or the board is full. */
  addNote({ x, y, color, text = "" }: { x: number; y: number; color: NoteColor; text?: string }): string | null {
    if (!this.live || !this.view.you) return null;
    if (this.view.board.notes.length >= MAX_NOTES_PER_ROOM) {
      this.update({ noteNotice: NOTICES.full });
      return null;
    }
    const clean = cleanNoteText(text);
    if (clean === null) return null;
    const clientRef = randomRef();
    const board = addLocal(this.view.board, { clientRef, x, y, color, text: clean, authorId: this.view.you.id });
    const note = findNote(board, localId(clientRef))?.note;
    if (!note) return null;
    this.update({ board, noteNotice: null });
    this.send({ type: "noteAdd", clientRef, x: note.x, y: note.y, color, text: clean });
    return note.id;
  }

  /** Commits an edit. Text is cleaned; an unchanged text just ends the draft. False if refused. */
  editNote(id: string, text: string): boolean {
    if (!this.live) return false;
    const entry = findNote(this.view.board, id);
    const clean = cleanNoteText(text);
    if (!entry || clean === null) return false;
    if (clean === entry.note.text) {
      this.update({ board: setDraft(this.view.board, id, null) });
      return true;
    }
    this.update({ board: editLocal(this.view.board, id, clean), noteNotice: null });
    // A note that isn't confirmed yet gets its text sent once it has a server id.
    if (!isLocalId(id)) this.send({ type: "noteEdit", id, text: clean });
    return true;
  }

  /** Text being typed; kept even if someone else changes the note meanwhile. */
  setDraft(id: string, draft: string | null): void {
    if (this.stopped) return;
    this.update({ board: setDraft(this.view.board, id, draft) });
  }

  /** Starts a drag. False for a note that can't move yet (not connected, or not confirmed). */
  startDrag(id: string): boolean {
    if (!this.live || isLocalId(id) || !findNote(this.view.board, id)) return false;
    this.update({ board: setDragging(this.view.board, id, true), noteNotice: null });
    return true;
  }

  /**
   * Moves a note here at once. Non-final moves are sent at most every MOVE_INTERVAL_MS
   * (the latest position wins); the final one is sent straight away and stored by the server.
   */
  moveNote(id: string, x: number, y: number, final: boolean): void {
    if (!this.live || isLocalId(id)) return;
    if (!findNote(this.view.board, id)) return this.stopMove(id);
    let board = moveLocal(this.view.board, id, x, y);
    if (final) board = setDragging(board, id, false);
    this.update({ board });
    if (final) {
      this.stopMove(id);
      return this.sendMove(id, true);
    }
    this.throttle(this.moves, id, MOVE_INTERVAL_MS, () => this.sendMove(id, false));
  }

  /** Starts a resize (a handle grabbed). False for a note that can't be resized yet. */
  startResize(id: string): boolean {
    if (!this.live || isLocalId(id) || !findNote(this.view.board, id)) return false;
    this.update({ board: setResizing(this.view.board, id, true), noteNotice: null });
    return true;
  }

  /**
   * Resizes a note here at once (position and size together, clamped). Non-final resizes are sent
   * at most every RESIZE_INTERVAL_MS; the final one is sent straight away and stored.
   */
  resizeNote(id: string, rect: NoteRect, final: boolean): void {
    if (!this.live || isLocalId(id)) return;
    if (!findNote(this.view.board, id)) return this.stopResize(id);
    let board = resizeLocal(this.view.board, id, rect);
    if (final) board = setResizing(board, id, false);
    this.update({ board });
    if (final) {
      this.stopResize(id);
      return this.sendResize(id, true);
    }
    this.throttle(this.resizes, id, RESIZE_INTERVAL_MS, () => this.sendResize(id, false));
  }

  /** The Width/Height fields: one final resize at the same position. False if refused. */
  setNoteSize(id: string, w: number, h: number): boolean {
    const entry = findNote(this.view.board, id);
    if (!this.live || isLocalId(id) || !entry) return false;
    const { x, y } = entry.note;
    const board = resizeLocal(this.view.board, id, { x, y, w, h });
    if (board === this.view.board) return true;
    this.update({ board, noteNotice: null });
    this.sendResize(id, true);
    return true;
  }

  /**
   * Colour and text style: shown at once, sent as one noteEdit with just those fields, rolled
   * back if refused. A note not confirmed yet gets them sent once it has its server id.
   */
  styleNote(id: string, change: StylePatch): boolean {
    if (!this.live) return false;
    const entry = findNote(this.view.board, id);
    if (!entry) return false;
    const board = styleLocal(this.view.board, id, change);
    if (board === this.view.board) return true;
    const changed = styleChanges(entry.note, findNote(board, id)?.note ?? entry.note);
    this.update({ board, noteNotice: null });
    if (!isLocalId(id)) this.send({ type: "noteEdit", id, ...changed });
    return true;
  }

  /** Deletes a note here at once. */
  deleteNote(id: string): void {
    if (!this.live) return;
    const entry = findNote(this.view.board, id);
    if (!entry) return;
    this.stopMove(id);
    this.stopResize(id);
    this.update({ board: deleteLocal(this.view.board, id), noteNotice: null });
    if (entry.clientRef !== null) this.abandoned.add(entry.clientRef);
    else this.send({ type: "noteDelete", id });
  }

  /** Sends now if `interval` has passed since the last send, else once it has (the latest wins). */
  private throttle(map: Map<string, Throttle>, id: string, interval: number, sendNow: () => void): void {
    const now = Date.now();
    const state = map.get(id) ?? { last: -Infinity, timer: undefined };
    map.set(id, state);
    if (now - state.last >= interval) {
      state.last = now;
      return sendNow();
    }
    state.timer ??= setTimeout(() => {
      state.timer = undefined;
      state.last = Date.now();
      sendNow();
    }, state.last + interval - now);
  }

  private sendResize(id: string, final: boolean): void {
    const entry = findNote(this.view.board, id);
    if (!entry || !this.live) return;
    const { x, y, w, h } = entry.note;
    this.send({ type: "noteResize", id, x, y, w, h, final });
  }

  private stopResize(id: string): void {
    clearTimeout(this.resizes.get(id)?.timer);
    this.resizes.delete(id);
  }

  private sendMove(id: string, final: boolean): void {
    const entry = findNote(this.view.board, id);
    if (!entry || !this.live) return;
    this.send({ type: "noteMove", id, x: entry.note.x, y: entry.note.y, final });
  }

  private stopMove(id: string): void {
    clearTimeout(this.moves.get(id)?.timer);
    this.moves.delete(id);
  }

  private stopAllMoves(): void {
    for (const id of [...this.moves.keys()]) this.stopMove(id);
    for (const id of [...this.resizes.keys()]) this.stopResize(id);
  }

  /** Leaves: closes the socket and reports nothing further. */
  close(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.stopAllMoves();
    this.socket?.close();
  }

  private onOpen(): void {
    if (this.stopped) return;
    this.opened = true;
    this.send({ type: "hello", protocolVersion: PROTOCOL_VERSION });
  }

  private onClose(): void {
    if (this.stopped) return;
    const { status } = this.view;
    if (status === "invalid" || status === "full" || status === "reload" || status === "unreachable") return;
    clearTimeout(this.timer);
    this.stopAllMoves();
    this.socket = null;
    if (status === "joined") return this.update({ status: "disconnected" });
    if (this.opened) return this.update({ status: "unreachable" });
    // Never opened: the relay refused the upgrade. Find out whether the code is the reason.
    void this.options.checkCode().then((check) => {
      if (!this.stopped) this.update({ status: check === "invalid" ? "invalid" : "unreachable" });
    });
  }

  private onMessage(data: unknown): void {
    if (this.stopped) return;
    const parsed = parseMessage(typeof data === "string" ? data : new ArrayBuffer(0), serverMessageSchema, MAX_SERVER_MESSAGE_BYTES);
    if (!parsed.ok) return this.finish("reload");
    this.handle(parsed.value);
  }

  private handle(message: ServerMessage): void {
    switch (message.type) {
      case "welcome":
        if (message.protocolVersion !== PROTOCOL_VERSION) return this.finish("reload");
        this.welcomed = true;
        if (this.pendingName !== null) this.send({ type: "join", name: this.pendingName });
        return;

      case "joined":
        clearTimeout(this.timer);
        for (const p of message.participants) this.known.set(p.id, p);
        this.known.set(message.you.id, message.you);
        return this.update({
          status: "joined",
          you: message.you,
          participants: message.participants,
          nameError: false,
          people: new Map(this.known),
        });

      case "participant_joined": {
        const p = message.participant;
        this.known.set(p.id, p);
        const others = this.view.participants.filter((q) => q.id !== p.id);
        return this.update({ participants: [...others, p], announcement: `${p.name} joined`, people: new Map(this.known) });
      }

      case "participant_left": {
        const gone = this.view.participants.find((p) => p.id === message.id);
        if (!gone) return;
        return this.update({
          participants: this.view.participants.filter((p) => p.id !== message.id),
          announcement: `${gone.name} left`,
        });
      }

      case "echo": {
        const sender = this.known.get(message.from);
        if (!sender) return;
        const entry: EchoEntry = {
          key: this.nextKey++,
          from: sender.id,
          name: sender.name,
          colourIndex: sender.colourIndex,
          text: message.text,
          at: Date.now(),
        };
        const mine = sender.id === this.view.you?.id;
        return this.update({
          messages: [...this.view.messages, entry].slice(-MAX_MESSAGES),
          ...(mine ? { rateLimited: false } : {}),
        });
      }

      case "snapshot":
        return this.update({ board: applySnapshot(this.view.board, message.notes), synced: true });

      case "noteAdded": {
        const { note, clientRef } = message;
        const temp = clientRef === undefined ? undefined : findNote(this.view.board, localId(clientRef));
        let board = applyAdded(this.view.board, note, clientRef);
        if (clientRef !== undefined && this.abandoned.delete(clientRef)) {
          // Deleted here before the server confirmed it.
          board = deleteLocal(board, note.id);
          this.send({ type: "noteDelete", id: note.id });
        } else if (temp) {
          // Text, colour or style committed while the add was in flight: one edit with all of it.
          const edit = { ...(temp.note.text !== note.text ? { text: temp.note.text } : {}), ...styleChanges(note, temp.note) };
          if (Object.keys(edit).length > 0) this.send({ type: "noteEdit", id: note.id, ...edit });
        }
        if (temp) this.options.onNoteConfirmed?.(temp.note.id, note.id);
        return this.update({ board, ...(clientRef !== undefined ? { rateLimited: false } : {}) });
      }

      case "noteUpdated":
        return this.update({ board: applyUpdated(this.view.board, message.note) });

      case "noteMoved":
        return this.update({ board: applyMoved(this.view.board, message) });

      case "noteResized":
        return this.update({ board: applyResized(this.view.board, message) });

      case "noteDeleted": {
        this.stopMove(message.id);
        this.stopResize(message.id);
        const editing = findNote(this.view.board, message.id)?.draft != null;
        return this.update({
          board: applyDeleted(this.view.board, message.id),
          ...(editing ? { noteNotice: NOTICES.deletedWhileEditing } : {}),
        });
      }

      case "error":
        if (message.clientRef !== undefined || message.noteId !== undefined) return this.noteRefused(message);
        switch (message.code) {
          case "version_mismatch":
            return this.finish("reload");
          case "room_full":
            return this.finish("full");
          case "invalid_name":
            clearTimeout(this.timer);
            return this.update({ status: "idle", nameError: true });
          case "rate_limited":
            return this.update({ rateLimited: true });
          case "notes_full":
            return this.update({ noteNotice: NOTICES.full });
          case "bad_message":
          case "too_large":
          case "not_joined":
          case "already_joined":
            return;
        }
    }
  }

  /** The server refused a note change: roll it back and say why. */
  private noteRefused(message: Extract<ServerMessage, { type: "error" }>): void {
    let board = this.view.board;
    if (message.clientRef !== undefined) {
      this.abandoned.delete(message.clientRef);
      board = rejectAdd(board, message.clientRef);
    }
    if (message.noteId !== undefined) {
      this.stopMove(message.noteId);
      this.stopResize(message.noteId);
      board = rollback(board, message.noteId);
    }
    const noteNotice =
      message.code === "notes_full" ? NOTICES.full : message.code === "rate_limited" ? NOTICES.tooQuick : NOTICES.refused;
    this.update({ board, noteNotice, ...(message.code === "rate_limited" ? { rateLimited: true } : {}) });
  }

  private startTimer(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (this.view.status === "connecting") this.finish("unreachable");
    }, JOIN_TIMEOUT_MS);
  }

  /** A final state: report it and close the socket. */
  private finish(status: RoomStatus): void {
    clearTimeout(this.timer);
    this.update({ status });
    this.socket?.close();
    this.socket = null;
  }

  private send(message: ClientMessage): void {
    try {
      this.socket?.send(encodeMessage(message));
    } catch {
      // The close handler reports the lost connection.
    }
  }

  private update(patch: Partial<RoomView>): void {
    this.view = { ...this.view, ...patch };
    this.options.onChange(this.view);
  }
}
