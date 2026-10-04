import {
  MAX_BATCH_ENTRIES,
  MAX_FRAMES_PER_ROOM,
  MAX_NOTES_PER_ROOM,
  MAX_SERVER_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  clampFramePosition,
  cleanFrameTitle,
  cleanName,
  cleanNoteText,
  cleanText,
  encodeMessage,
  groupOffset,
  parseMessage,
  serverMessageSchema,
  stackOrder,
  type ClientMessage,
  type FrameColor,
  type NoteBatchEntry,
  type NoteColor,
  type NoteRect,
  type OrderAction,
  type Participant,
  type ServerMessage,
} from "@stickyard/shared";
import type { SocketFactory, SocketLike } from "../connection/socket";
import {
  addFrameLocal,
  applyFrameAdded,
  applyFrameDeleted,
  applyFrameMoved,
  applyFrameResized,
  applyFrameUpdated,
  applyFramesSnapshot,
  deleteFrameLocal,
  editFrameLocal,
  findFrame,
  frameChanges,
  framedNotes,
  moveFrameLocal,
  rejectFrameAdd,
  resizeFrameLocal,
  rollbackFrame,
  setFrameDraft,
  setFrameDragging,
  setFrameResizing,
  type FrameEdit,
} from "../frames/board";
import {
  EMPTY_BOARD,
  addLocal,
  applyAdded,
  applyDeleted,
  applyMoved,
  applyOrdered,
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
  reorderLocal,
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
  /** The template being applied here (template tiles are off meanwhile), or how the last one ended. */
  template: TemplateRun | null;
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
  template: null,
  people: new Map(),
};

export const JOIN_TIMEOUT_MS = 10_000;
/** Echoes kept on screen. */
export const MAX_MESSAGES = 100;
/** Drag updates are sent at most this often per note (about 20 a second), then once on drop. */
export const MOVE_INTERVAL_MS = 50;
/** Resize updates likewise: at most about 20 a second per note, then once on release. */
export const RESIZE_INTERVAL_MS = 50;
/**
 * A group drag is sent at most this often (up to MAX_BATCH_ENTRIES notes each time, about 500
 * entries a second at most, inside the relay's BATCH_LIMITS), then once on drop.
 */
export const GROUP_MOVE_INTERVAL_MS = 100;

/**
 * A template is sent at most this many messages a second: a third of the relay's SOCKET_LIMITS
 * (30 a second, burst 40), so typing or dragging at the same time still fits.
 */
export const TEMPLATE_MESSAGES_PER_SECOND = 10;
/** The gap between a template's messages. */
export const TEMPLATE_STEP_MS = 1000 / TEMPLATE_MESSAGES_PER_SECOND;

/** A template run: `frameIds` are the frames it made (server ids, in template order) once it ends. */
export interface TemplateRun {
  seq: number;
  state: "applying" | "done" | "partial";
  frameIds: readonly string[];
}

/** One frame of a template to apply: where it goes, its size, title, colour and title style. */
export interface TemplateFramePlan {
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  color: FrameColor;
  style: FrameEdit;
}

/** A template being applied: its steps (one message each, paced) and each frame's id so far. */
interface TemplateApply {
  seq: number;
  plans: readonly TemplateFramePlan[];
  /** Local id once added, server id once confirmed; null before it's added or if it was deleted meanwhile. */
  ids: (string | null)[];
  confirmed: boolean[];
  steps: (() => boolean)[];
  timer: ReturnType<typeof setTimeout> | undefined;
  /** When the next message may go. */
  nextAt: number;
}

export const NOTICES = {
  full: `The board is full (${MAX_NOTES_PER_ROOM} notes). Delete a note to add another.`,
  tooQuick: "That change was too quick and wasn’t saved. Try again.",
  refused: "That change wasn’t saved. Try again.",
  deletedWhileEditing: "Someone else deleted the note you were editing.",
  framesFull: `The board has the maximum of ${MAX_FRAMES_PER_ROOM} frames. Delete a frame to add another.`,
  frameTooFull: `This frame holds more than ${MAX_BATCH_ENTRIES} notes, so it moved on its own.`,
  templatePartial: "The template was only partly added. The frames that were added stay on the board; delete any you don’t want.",
  templateNoRoom: (needs: number, free: number) => `This template needs ${needs} frames, but the board has room for ${free} more.`,
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
  /** A frame added here got its server id. */
  onFrameConfirmed?(localId: string, id: string): void;
}

/** A frame being dragged here: where it and the notes it carries started. */
interface FrameDrag {
  id: string;
  start: NoteRect;
  /** Carried notes (confirmed ids only), by id, at their start. Empty: the frame moves alone. */
  notes: Map<string, NoteRect>;
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
  /** The group being dragged (confirmed ids), and its send throttle. */
  private group: string[] = [];
  private readonly groupMoves = new Map<string, Throttle>();
  /** Frames: live move and resize throttles, adds deleted before they were confirmed, and the drag in progress. */
  private readonly frameMoves = new Map<string, Throttle>();
  private readonly frameResizes = new Map<string, Throttle>();
  private readonly abandonedFrames = new Set<string>();
  private frameDrag: FrameDrag | null = null;
  /** The template being applied, if any (one at a time). */
  private template: TemplateApply | null = null;
  private templateSeq = 0;

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

  /** Starts dragging several notes together. False if none of them can move now. */
  startGroupDrag(ids: readonly string[]): boolean {
    if (!this.live) return false;
    const movable = ids.filter((id) => !isLocalId(id) && findNote(this.view.board, id));
    if (movable.length === 0) return false;
    let board = this.view.board;
    for (const id of movable) board = setDragging(board, id, true);
    this.group = movable;
    this.update({ board, noteNotice: null });
    return true;
  }

  /**
   * Moves a group here at once (positions already clamped as a group; see canvas/arrange.ts).
   * While dragging, the first MAX_BATCH_ENTRIES notes are sent at most every
   * GROUP_MOVE_INTERVAL_MS (the rest catch up on drop); the drop goes out as final batches of
   * MAX_BATCH_ENTRIES (each stored on its own, not atomically across batches).
   */
  moveGroup(positions: readonly { id: string; x: number; y: number }[], final: boolean): void {
    if (!this.live) return;
    const known = positions.filter((p) => !isLocalId(p.id) && findNote(this.view.board, p.id));
    let board = this.view.board;
    for (const p of known) {
      board = moveLocal(board, p.id, p.x, p.y);
      if (final) board = setDragging(board, p.id, false);
    }
    this.update({ board });
    if (final) {
      this.stopGroup();
      this.sendBatch(this.moveEntries(known.map((p) => p.id)), true);
      return;
    }
    this.group = known.map((p) => p.id);
    this.throttle(this.groupMoves, "group", GROUP_MOVE_INTERVAL_MS, () =>
      this.sendBatch(this.moveEntries(this.group.slice(0, MAX_BATCH_ENTRIES)), false),
    );
  }

  /**
   * Arrange (align, distribute, match size): new rects for several notes, shown at once and sent
   * as final batches. Position-only changes go as moves, size changes as resizes. False if refused.
   */
  applyRects(rects: readonly (NoteRect & { id: string })[]): boolean {
    if (!this.live) return false;
    let board = this.view.board;
    const ops: NoteBatchEntry[] = [];
    for (const rect of rects) {
      const before = findNote(board, rect.id)?.note;
      if (!before || isLocalId(rect.id)) continue;
      board = resizeLocal(board, rect.id, rect);
      const after = findNote(board, rect.id)?.note;
      if (!after || after === before) continue;
      const { id, x, y, w, h } = after;
      ops.push(w === before.w && h === before.h ? { op: "move", id, x, y } : { op: "resize", id, x, y, w, h });
    }
    if (ops.length === 0) return true;
    this.update({ board, noteNotice: null });
    this.sendBatch(ops, true);
    return true;
  }

  /** Deletes several notes here at once, sent as batches of deletes. */
  deleteNotes(ids: readonly string[]): void {
    if (!this.live) return;
    let board = this.view.board;
    const ops: NoteBatchEntry[] = [];
    for (const id of ids) {
      const entry = findNote(board, id);
      if (!entry) continue;
      this.stopMove(id);
      this.stopResize(id);
      board = deleteLocal(board, id);
      if (entry.clientRef !== null) this.abandoned.add(entry.clientRef);
      else ops.push({ op: "delete", id });
    }
    this.update({ board, noteNotice: null });
    this.sendBatch(ops, true);
  }

  /**
   * Bring to front or send to back: shown at once, rolled back if refused. Notes still waiting
   * for their server id are left out. More than MAX_BATCH_ENTRIES go in chunks taken in stacking
   * order, front bottom-up and back top-down, so each chunk lands past the last and the notes
   * keep their order among themselves (each chunk is stored on its own). False if refused.
   */
  orderNotes(ids: readonly string[], action: OrderAction): boolean {
    if (!this.live) return false;
    const notes = ids.flatMap((id) => (isLocalId(id) ? [] : (findNote(this.view.board, id)?.note ?? [])));
    if (notes.length === 0) return true;
    const ordered = stackOrder(notes).map((n) => n.id);
    const board = reorderLocal(this.view.board, ordered, action);
    if (board !== this.view.board) this.update({ board, noteNotice: null });
    const chunks: string[][] = [];
    for (let i = 0; i < ordered.length; i += MAX_BATCH_ENTRIES) chunks.push(ordered.slice(i, i + MAX_BATCH_ENTRIES));
    for (const chunk of action === "front" ? chunks : chunks.reverse()) this.send({ type: "notesOrder", ids: chunk, action });
    return true;
  }

  /* ── Frames (protocol v9) ─────────────────────────────────────────── */

  /**
   * Adds a frame (plain data: position, colour, title), shown at once. Its temporary id, or null
   * if not connected, the board has its frames already, or the title is too long.
   */
  addFrame({ x, y, color, title = "" }: { x: number; y: number; color: FrameColor; title?: string }): string | null {
    if (!this.live || !this.view.you) return null;
    if (this.view.board.frames.length >= MAX_FRAMES_PER_ROOM) {
      this.update({ noteNotice: NOTICES.framesFull });
      return null;
    }
    const clean = cleanFrameTitle(title);
    if (clean === null) return null;
    const clientRef = randomRef();
    const board = addFrameLocal(this.view.board, { clientRef, x, y, color, title: clean, authorId: this.view.you.id });
    const frame = findFrame(board, localId(clientRef))?.frame;
    if (!frame) return null;
    this.update({ board, noteNotice: null });
    this.send({ type: "frameAdd", clientRef, x: frame.x, y: frame.y, color, title: clean });
    return frame.id;
  }

  /**
   * A title (cleaned to one line), colour and/or title style, shown at once; only the fields that
   * changed are sent. A frame not confirmed yet sends them once it is. False if refused.
   */
  editFrame(id: string, change: FrameEdit): boolean {
    if (!this.live) return false;
    const entry = findFrame(this.view.board, id);
    const title = change.title === undefined ? undefined : cleanFrameTitle(change.title);
    if (!entry || title === null) return false;
    const before = entry.frame;
    const board = editFrameLocal(this.view.board, id, { ...change, ...(title !== undefined ? { title } : {}) });
    const after = findFrame(board, id)?.frame ?? before;
    this.update({ board, noteNotice: null });
    if (isLocalId(id)) return true;
    const edit = frameChanges(before, after);
    if (Object.keys(edit).length > 0) this.send({ type: "frameEdit", id, ...edit });
    return true;
  }

  /** The title being typed in a frame's header; kept even if someone else edits the frame meanwhile. */
  setFrameDraft(id: string, draft: string | null): void {
    if (this.stopped) return;
    this.update({ board: setFrameDraft(this.view.board, id, draft) });
  }

  /**
   * Starts dragging a frame. With `carry`, the notes whose centre is inside it come along (unless
   * there are more than MAX_BATCH_ENTRIES: then it moves alone, and says so; it never carries
   * some). False if the frame can't move now.
   */
  startFrameDrag(id: string, carry: boolean): boolean {
    const entry = findFrame(this.view.board, id);
    if (!this.live || isLocalId(id) || !entry) return false;
    const inside = carry ? framedNotes(entry.frame, this.view.board.notes.map((n) => n.note)).filter((n) => !isLocalId(n.id)) : [];
    const tooMany = inside.length > MAX_BATCH_ENTRIES;
    const notes = new Map(tooMany ? [] : inside.map((n) => [n.id, { x: n.x, y: n.y, w: n.w, h: n.h }] as const));
    let board = setFrameDragging(this.view.board, id, true);
    for (const noteId of notes.keys()) board = setDragging(board, noteId, true);
    const { x, y, w, h } = entry.frame;
    this.frameDrag = { id, start: { x, y, w, h }, notes };
    this.update({ board, noteNotice: tooMany ? NOTICES.frameTooFull : null });
    return true;
  }

  /**
   * Moves a frame (and the notes it carries, by the same delta clamped once for the group) here
   * at once. Live moves are sent at most every MOVE_INTERVAL_MS; the final one straight away.
   */
  moveFrame(id: string, x: number, y: number, final: boolean): void {
    if (!this.live || isLocalId(id)) return;
    const entry = findFrame(this.view.board, id);
    if (!entry) return this.stopFrameMove(id);
    const drag = this.frameDrag?.id === id ? this.frameDrag : { id, start: { x: entry.frame.x, y: entry.frame.y, w: entry.frame.w, h: entry.frame.h }, notes: new Map<string, NoteRect>() };
    const target = clampFramePosition(x, y, drag.start);
    const want = { dx: target.x - drag.start.x, dy: target.y - drag.start.y };
    const { dx, dy } = drag.notes.size > 0 ? groupOffset([drag.start, ...drag.notes.values()], want.dx, want.dy) : want;
    let board = moveFrameLocal(this.view.board, id, drag.start.x + dx, drag.start.y + dy);
    for (const [noteId, r] of drag.notes) board = moveLocal(board, noteId, r.x + dx, r.y + dy);
    const noteIds = [...drag.notes.keys()].filter((n) => findNote(board, n));
    if (final) {
      board = setFrameDragging(board, id, false);
      for (const n of drag.notes.keys()) board = setDragging(board, n, false);
      this.frameDrag = null;
    }
    this.update({ board });
    if (final) {
      this.stopFrameMove(id);
      return this.sendFrameMove(id, noteIds, true);
    }
    this.throttle(this.frameMoves, id, MOVE_INTERVAL_MS, () => this.sendFrameMove(id, noteIds, false));
  }

  startFrameResize(id: string): boolean {
    if (!this.live || isLocalId(id) || !findFrame(this.view.board, id)) return false;
    this.update({ board: setFrameResizing(this.view.board, id, true), noteNotice: null });
    return true;
  }

  /** Resizes a frame here at once (clamped to frame sizes); live resizes throttled, the final one stored. */
  resizeFrame(id: string, rect: NoteRect, final: boolean): void {
    if (!this.live || isLocalId(id)) return;
    if (!findFrame(this.view.board, id)) return this.stopFrameResize(id);
    let board = resizeFrameLocal(this.view.board, id, rect);
    if (final) board = setFrameResizing(board, id, false);
    this.update({ board });
    if (final) {
      this.stopFrameResize(id);
      return this.sendFrameResize(id, true);
    }
    this.throttle(this.frameResizes, id, RESIZE_INTERVAL_MS, () => this.sendFrameResize(id, false));
  }

  /** The Width/Height fields: one final resize at the same position. */
  setFrameSize(id: string, w: number, h: number): boolean {
    const entry = findFrame(this.view.board, id);
    if (!entry) return false;
    return this.setFrameRect(id, { x: entry.frame.x, y: entry.frame.y, w, h });
  }

  /** One final resize to this position and size (clamped). */
  setFrameRect(id: string, rect: NoteRect): boolean {
    if (!this.live || isLocalId(id) || !findFrame(this.view.board, id)) return false;
    const board = resizeFrameLocal(this.view.board, id, rect);
    if (board === this.view.board) return true;
    this.update({ board, noteNotice: null });
    this.sendFrameResize(id, true);
    return true;
  }

  /* ── Templates ──────────────────────────────────────────────────── */

  /**
   * Applies a template: for each frame, frameAdd (position, colour, title); once the relay
   * confirms it, one final resize to its size and one edit for its title style. One message
   * every TEMPLATE_STEP_MS at most. Existing frames and notes are never touched. Refused (and
   * nothing sent) while disconnected, while another template is being applied, or when the
   * board hasn't enough free frame slots (a notice says how many it needs and has). A refusal
   * part-way ends it: what was made stays, one notice says so, nothing is retried.
   */
  applyTemplate(frames: readonly TemplateFramePlan[]): boolean {
    if (!this.live || this.template || frames.length === 0) return false;
    const free = Math.max(0, MAX_FRAMES_PER_ROOM - this.view.board.frames.length);
    if (frames.length > free) {
      this.update({ noteNotice: NOTICES.templateNoRoom(frames.length, free) });
      return false;
    }
    const run: TemplateApply = {
      seq: ++this.templateSeq,
      plans: frames,
      ids: frames.map(() => null),
      confirmed: frames.map(() => false),
      steps: [],
      timer: undefined,
      nextAt: 0,
    };
    frames.forEach((plan, i) =>
      run.steps.push(() => {
        const id = this.addFrame({ x: plan.x, y: plan.y, color: plan.color, title: plan.title });
        run.ids[i] = id;
        return id !== null;
      }),
    );
    this.template = run;
    this.update({ template: { seq: run.seq, state: "applying", frameIds: [] }, noteNotice: null });
    this.templateStep();
    return true;
  }

  /** Sends the template's next step, if any, then waits TEMPLATE_STEP_MS; done once every frame is confirmed and nothing is left. */
  private templateStep(): void {
    const run = this.template;
    if (!run) return;
    run.timer = undefined;
    const step = run.steps.shift();
    if (!step) {
      if (run.confirmed.every(Boolean)) this.endTemplate("done");
      return;
    }
    if (!step()) return this.endTemplate("partial");
    run.nextAt = Date.now() + TEMPLATE_STEP_MS;
    run.timer = setTimeout(() => this.templateStep(), TEMPLATE_STEP_MS);
  }

  /** A template frame got its server id (or was deleted here before that): queue its resize and style edit. */
  private templateConfirmed(local: string, id: string, gone: boolean): void {
    const run = this.template;
    const i = run ? run.ids.indexOf(local) : -1;
    if (!run || i < 0) return;
    run.confirmed[i] = true;
    run.ids[i] = gone ? null : id;
    const plan = run.plans[i];
    if (!gone && plan) {
      run.steps.push(() => {
        this.setFrameRect(id, plan);
        return this.live;
      });
      run.steps.push(() => {
        this.editFrame(id, plan.style);
        return this.live;
      });
    }
    if (run.timer === undefined) run.timer = setTimeout(() => this.templateStep(), Math.max(0, run.nextAt - Date.now()));
  }

  /** Does this refusal belong to the template being applied? */
  private templateOwns(message: Extract<ServerMessage, { type: "error" }>): boolean {
    const ids = this.template?.ids ?? [];
    return (message.clientRef !== undefined && ids.includes(localId(message.clientRef))) || (message.frameId !== undefined && ids.includes(message.frameId));
  }

  private endTemplate(state: "done" | "partial"): void {
    const run = this.template;
    if (!run) return;
    clearTimeout(run.timer);
    this.template = null;
    const frameIds = run.ids.filter((id, i): id is string => id !== null && run.confirmed[i] === true);
    this.update({ template: { seq: run.seq, state, frameIds }, ...(state === "partial" ? { noteNotice: NOTICES.templatePartial } : {}) });
  }

  /** Deletes a frame here at once. Never its notes. */
  deleteFrame(id: string): void {
    if (!this.live) return;
    const entry = findFrame(this.view.board, id);
    if (!entry) return;
    this.stopFrameMove(id);
    this.stopFrameResize(id);
    this.update({ board: deleteFrameLocal(this.view.board, id), noteNotice: null });
    if (entry.clientRef !== null) this.abandonedFrames.add(entry.clientRef);
    else this.send({ type: "frameDelete", id });
  }

  private sendFrameMove(id: string, noteIds: readonly string[], final: boolean): void {
    const frame = findFrame(this.view.board, id)?.frame;
    if (!frame || !this.live) return;
    this.send({ type: "frameMove", id, x: frame.x, y: frame.y, final, ...(noteIds.length > 0 ? { noteIds: [...noteIds] } : {}) });
  }

  private sendFrameResize(id: string, final: boolean): void {
    const frame = findFrame(this.view.board, id)?.frame;
    if (!frame || !this.live) return;
    this.send({ type: "frameResize", id, x: frame.x, y: frame.y, w: frame.w, h: frame.h, final });
  }

  private stopFrameMove(id: string): void {
    clearTimeout(this.frameMoves.get(id)?.timer);
    this.frameMoves.delete(id);
  }

  private stopFrameResize(id: string): void {
    clearTimeout(this.frameResizes.get(id)?.timer);
    this.frameResizes.delete(id);
  }

  private moveEntries(ids: readonly string[]): NoteBatchEntry[] {
    return ids.flatMap((id) => {
      const note = findNote(this.view.board, id)?.note;
      return note ? [{ op: "move" as const, id, x: note.x, y: note.y }] : [];
    });
  }

  /** In chunks of MAX_BATCH_ENTRIES. */
  private sendBatch(ops: readonly NoteBatchEntry[], final: boolean): void {
    if (!this.live) return;
    for (let i = 0; i < ops.length; i += MAX_BATCH_ENTRIES) this.send({ type: "noteBatch", ops: ops.slice(i, i + MAX_BATCH_ENTRIES), final });
  }

  private stopGroup(): void {
    clearTimeout(this.groupMoves.get("group")?.timer);
    this.groupMoves.delete("group");
    this.group = [];
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
    for (const id of [...this.frameMoves.keys()]) this.stopFrameMove(id);
    for (const id of [...this.frameResizes.keys()]) this.stopFrameResize(id);
    this.frameDrag = null;
    this.stopGroup();
  }

  /** Leaves: closes the socket and reports nothing further. */
  close(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    clearTimeout(this.template?.timer);
    this.template = null;
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
    if (status === "joined") {
      this.update({ status: "disconnected" });
      // Cut off part-way: what was made stays, and the notice says so.
      return this.endTemplate("partial");
    }
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

      case "notesBatchApplied": {
        // One view update for the whole batch.
        let board = this.view.board;
        let editingDeleted = false;
        for (const result of message.results) {
          if (result.type === "noteMoved") board = applyMoved(board, result);
          else if (result.type === "noteResized") board = applyResized(board, result);
          else {
            this.stopMove(result.id);
            this.stopResize(result.id);
            editingDeleted ||= findNote(board, result.id)?.draft != null;
            board = applyDeleted(board, result.id);
          }
        }
        return this.update({ board, ...(editingDeleted ? { noteNotice: NOTICES.deletedWhileEditing } : {}) });
      }

      case "notesOrdered":
        // One view update for every restacked note.
        return this.update({ board: applyOrdered(this.view.board, message.results) });

      case "framesSnapshot":
        // Right after the notes snapshot. The board is already joined and drawn; frames slot in behind.
        return this.update({ board: applyFramesSnapshot(this.view.board, message.frames) });

      case "frameAdded": {
        const { frame, clientRef } = message;
        const temp = clientRef === undefined ? undefined : findFrame(this.view.board, localId(clientRef));
        let board = applyFrameAdded(this.view.board, frame, clientRef);
        if (clientRef !== undefined && this.abandonedFrames.delete(clientRef)) {
          board = deleteFrameLocal(board, frame.id);
          this.send({ type: "frameDelete", id: frame.id });
        } else if (temp) {
          // A title, colour or title style set while the add was in flight: one edit with all of it.
          const edit = frameChanges(frame, temp.frame);
          if (Object.keys(edit).length > 0) this.send({ type: "frameEdit", id: frame.id, ...edit });
        }
        if (temp) this.options.onFrameConfirmed?.(temp.frame.id, frame.id);
        this.update({ board, ...(clientRef !== undefined ? { rateLimited: false } : {}) });
        if (temp) this.templateConfirmed(temp.frame.id, frame.id, findFrame(board, frame.id) === undefined);
        return;
      }

      case "frameUpdated":
        return this.update({ board: applyFrameUpdated(this.view.board, message.frame) });

      case "frameMoved": {
        // The frame and the notes it carried, in one view update.
        let board = applyFrameMoved(this.view.board, message);
        for (const n of message.notes ?? []) board = applyMoved(board, { ...n, final: message.final });
        return this.update({ board });
      }

      case "frameResized":
        return this.update({ board: applyFrameResized(this.view.board, message) });

      case "frameDeleted":
        this.stopFrameMove(message.id);
        this.stopFrameResize(message.id);
        return this.update({ board: applyFrameDeleted(this.view.board, message.id) });

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
        if (message.clientRef !== undefined || message.noteId !== undefined || message.noteIds !== undefined || message.frameId !== undefined) {
          const template = this.templateOwns(message);
          this.noteRefused(message);
          // A refused part of a template ends it; what it made stays (no rollback, no retry).
          if (template) this.endTemplate("partial");
          return;
        }
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
          case "frames_full":
            return this.update({ noteNotice: NOTICES.framesFull });
          case "bad_message":
          case "too_large":
          case "not_joined":
          case "already_joined":
            return;
        }
    }
  }

  /** The server refused a note or frame change: roll it back and say why. */
  private noteRefused(message: Extract<ServerMessage, { type: "error" }>): void {
    let board = this.view.board;
    if (message.clientRef !== undefined) {
      // A clientRef belongs to one add, a note's or a frame's.
      this.abandoned.delete(message.clientRef);
      this.abandonedFrames.delete(message.clientRef);
      board = rejectFrameAdd(rejectAdd(board, message.clientRef), message.clientRef);
    }
    if (message.frameId !== undefined) {
      this.stopFrameMove(message.frameId);
      this.stopFrameResize(message.frameId);
      if (this.frameDrag?.id === message.frameId) this.frameDrag = null;
      board = rollbackFrame(board, message.frameId);
    }
    // One note, or the notes a refused batch named (the rest of the batch stands). Last first, so
    // notes deleted together go back in their old places.
    for (const id of [...(message.noteId !== undefined ? [message.noteId] : []), ...(message.noteIds ?? [])].reverse()) {
      this.stopMove(id);
      this.stopResize(id);
      board = rollback(board, id);
    }
    const noteNotice =
      message.code === "notes_full"
        ? NOTICES.full
        : message.code === "frames_full"
          ? NOTICES.framesFull
          : message.code === "rate_limited"
            ? NOTICES.tooQuick
            : NOTICES.refused;
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
