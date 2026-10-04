import {
  FRAME_DEFAULTS,
  FRAME_STYLE_FIELDS,
  MAX_BATCH_ENTRIES,
  MAX_FRAMES_PER_ROOM,
  MAX_NOTES_PER_ROOM,
  MAX_SERVER_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  clampFramePosition,
  clampFrameRect,
  clampNoteRect,
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
  type Frame,
  type FrameColor,
  type FrameItem,
  type ItemRefusalReason,
  type Note,
  type NoteBatchEntry,
  type NoteItem,
  type NoteColor,
  type NoteRect,
  type OrderAction,
  type Participant,
  type ServerMessage,
} from "@stickyard/shared";
import type { SocketFactory, SocketLike } from "../connection/socket";
import {
  addFrameItemLocal,
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
  isFrameHeld,
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
  addItemLocal,
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
  isHeld,
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
import { DUPLICATE_HINTS, duplicateFrameInput, duplicateNoteInputs } from "../canvas/duplicate";
import { HISTORY_TEXT, History, type Fields, type ItemKind, type Lookup, type Plan } from "../history/history";
import type { CodeCheck } from "./api";
import { packItems, type ItemDraft, type ItemsAddMessage } from "./items";

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
  /** How the last delete of several notes went, until the next note action. */
  deleteReport: DeleteReport | null;
  /** The board snapshot has arrived (the first view can be fitted to the notes). */
  synced: boolean;
  /** The template being applied here (template tiles are off meanwhile), or how the last one ended. */
  template: TemplateRun | null;
  /** Everyone seen in this visit (including people who have left), by id: note authors' names. */
  people: ReadonlyMap<string, Participant>;
  /** itemsAdd messages are still queued or in flight (a duplicate, a template, a restore): another waits. */
  adding: boolean;
  /** Why Undo and Redo are off right now (null: they work). */
  history: { undo: string | null; redo: string | null };
  /** A restore in progress ("Restoring 120 of 200…"), or how the last undo or redo went, until the next note action. */
  historyReport: DeleteReport | null;
}

/** A delete's outcome: `partial` when some notes weren't (or may not have been) deleted. */
export interface DeleteReport {
  text: string;
  partial: boolean;
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
  deleteReport: null,
  synced: false,
  template: null,
  people: new Map(),
  adding: false,
  history: { undo: "Not connected.", redo: "Not connected." },
  historyReport: null,
};

/** What Undo and Redo say (with HISTORY_TEXT from the history itself). */
export const UNDO_TEXT = {
  offline: "Not connected.",
  busy: "Wait until the items being added are saved.",
  order: HISTORY_TEXT.order,
  restoring: (done: number, total: number) => `Restoring ${done} of ${total}…`,
  restored: (n: number) => `Restored ${n} ${n === 1 ? "item" : "items"}.`,
  restoredPartly: (done: number, total: number) => `Restored ${done} of ${total} items.`,
  restoreLost: (done: number, total: number) => `Restored ${done} of ${total} items. The connection was lost, so the rest weren’t restored.`,
} as const;

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
 * itemsAdd messages (addItems, templates) go out at most this many a second: a third of the
 * relay's SOCKET_LIMITS (30 a second, burst 40), so typing or dragging at the same time still
 * fits. At most MAX_BATCH_ENTRIES items each, so at most 500 entries a second, inside BATCH_LIMITS
 * (600 a second).
 */
export const ITEMS_MESSAGES_PER_SECOND = 10;
/** The gap between itemsAdd messages. */
export const ITEMS_STEP_MS = 1000 / ITEMS_MESSAGES_PER_SECOND;

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
  style: Pick<Frame, (typeof FRAME_STYLE_FIELDS)[number]>;
}

/** Plain data for addItems: a note or a frame with its full content (no id, ref, rev, z or author). */
export type ItemInput = ({ kind: "note" } & Omit<NoteItem, "ref">) | ({ kind: "frame" } & Omit<FrameItem, "ref">);

/** Items that weren't added, by why. */
export interface ItemsRefused {
  notesFull: number;
  framesFull: number;
  invalid: number;
  tooQuick: number;
}

/** One addItems call: its items by ref, until the relay has answered for each. */
interface ItemsRun {
  /** Each input's ref, in input order (null: not added here, its text too long after cleaning). */
  refs: (string | null)[];
  /** Refs still waiting for the relay. */
  pending: Set<string>;
  /** Server id once confirmed; null if refused, or deleted here before that. */
  ids: Map<string, string | null>;
  refused: ItemsRefused;
  /** The template it applies, if any (its seq). */
  template: number | null;
  /** An undo or redo adding items back (its progress is shown). */
  restore: boolean;
}

/** One itemsAdd message of a run: queued, then in flight until the relay answers. */
interface ItemsBatch {
  run: ItemsRun;
  message: ItemsAddMessage;
  sent: boolean;
}

/** A template being applied: its items run. */
interface TemplateApply {
  seq: number;
  run: ItemsRun;
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
  itemsNotAdded: (refused: ItemsRefused) => itemsNotice(refused),
  duplicateNoRoom: (kind: "note" | "frame", needs: number, free: number) =>
    kind === "note" ? DUPLICATE_HINTS.notesFull(needs, free) : DUPLICATE_HINTS.framesFull(free),
} as const;

const notesWord = (n: number) => (n === 1 ? "note" : "notes");
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"} ${n === 1 ? "wasn’t" : "weren’t"} added`;

/** What a notice says about items an addItems couldn't add, by reason. */
function itemsNotice({ notesFull, framesFull, invalid, tooQuick }: ItemsRefused): string {
  const parts: string[] = [];
  if (notesFull > 0) parts.push(`${plural(notesFull, "note")} because the board is full (${MAX_NOTES_PER_ROOM} notes).`);
  if (framesFull > 0) parts.push(`${plural(framesFull, "frame")} because the board has the maximum of ${MAX_FRAMES_PER_ROOM} frames.`);
  if (tooQuick > 0) parts.push(`${plural(tooQuick, "item")} because that was too quick. Try again.`);
  if (invalid > 0) parts.push(`${plural(invalid, "item")} because the relay refused ${invalid === 1 ? "it" : "them"}.`);
  return parts.join(" ");
}

/** Items of a run the relay has added. */
const restoredCount = (run: ItemsRun) => [...run.ids.values()].filter((id) => id !== null).length;

const refusedTotal = (r: ItemsRefused) => r.notesFull + r.framesFull + r.invalid + r.tooQuick;

/** Which ItemsRefused count a refusal adds to. */
function refusalKey(reason: ItemRefusalReason | "rate_limited"): keyof ItemsRefused {
  if (reason === "notes_full") return "notesFull";
  if (reason === "frames_full") return "framesFull";
  return reason === "rate_limited" ? "tooQuick" : "invalid";
}

/** The report for a delete of several notes, once every note in it is accounted for. */
export function deleteReportFor({ total, refused, tooQuick, lost }: { total: number; refused: number; tooQuick: boolean; lost: number }): DeleteReport {
  const deleted = total - refused - lost;
  if (refused === 0 && lost === 0) return { text: `Deleted ${deleted} ${notesWord(deleted)}.`, partial: false };
  const parts = [`Deleted ${deleted} of ${total} ${notesWord(total)}.`];
  if (refused > 0) {
    const one = refused === 1;
    const why = tooQuick ? "that was too quick" : "the relay refused it";
    parts.push(`${refused} ${one ? "wasn’t" : "weren’t"} deleted because ${why}; ${one ? "it’s" : "they’re"} back on the board. Try again.`);
  }
  if (lost > 0) {
    const one = lost === 1;
    parts.push(`The connection was lost before ${lost} ${one ? "was" : "were"} confirmed, so ${one ? "it" : "they"} may still be on the board.`);
  }
  return { text: parts.join(" "), partial: true };
}

export const DELETE_OFFLINE: DeleteReport = { text: "You’re not connected, so nothing was deleted.", partial: true };

/** A delete of several notes in flight: what the relay hasn't answered for yet, and what it refused. */
interface DeleteRun {
  total: number;
  /** Server ids waiting for the relay's delete. */
  ids: Set<string>;
  /** Adds deleted before they were confirmed: their clientRefs, until the id arrives (then in `ids`). */
  refs: Set<string>;
  refused: number;
  tooQuick: boolean;
}

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
  /** itemsAdd messages queued or in flight, by their clientRef; the queue (clientRefs) and its pacing timer. */
  private readonly itemBatches = new Map<string, ItemsBatch>();
  private itemQueue: string[] = [];
  private itemTimer: ReturnType<typeof setTimeout> | undefined;
  private templateSeq = 0;
  /** The delete of several notes being confirmed, if any (a new one joins it). */
  private deleteRun: DeleteRun | null = null;
  /** Undo and redo of my own actions (history/history.ts); cleared on resync, disconnect and leaving. */
  private readonly history = new History();
  /** Items being added back by an undo or redo, if any. */
  private restoreRun: ItemsRun | null = null;

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
    this.history.recordAdd("Add note", [{ kind: "note", id: note.id }], Date.now());
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
    if (!isLocalId(id)) {
      this.record("Edit text", [{ kind: "note", id, after: { text: clean } }]);
      this.send({ type: "noteEdit", id, text: clean });
    }
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
      this.recordRects("Move", ["note"], [id], ["x", "y"], `move:${id}`);
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
      this.recordRects("Resize", ["note"], [id], ["x", "y", "w", "h"], `resize:${id}`);
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
    this.recordRects("Resize", ["note"], [id], ["x", "y", "w", "h"]);
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
    if (!isLocalId(id)) {
      this.record("Style", [{ kind: "note", id, after: changed as Fields }]);
      this.send({ type: "noteEdit", id, ...changed });
    }
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
    if (entry.clientRef !== null) {
      this.abandoned.add(entry.clientRef);
      this.history.refuse("note", id);
    } else {
      this.recordRemoval("Delete note", [entry.note], []);
      this.send({ type: "noteDelete", id });
    }
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
      const ids = known.map((p) => p.id);
      this.recordRects("Move", ["note"], ids, ["x", "y"], `move:${[...ids].sort().join(",")}`);
      this.sendBatch(this.moveEntries(ids), true);
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
    this.recordRects("Arrange", ["note"], ops.map((o) => o.id), ["x", "y", "w", "h"]);
    this.sendBatch(ops, true);
    return true;
  }

  /** Shows a notice about the notes (an arrange that couldn't run, say), until the next note action. */
  showNotice(text: string): void {
    if (this.stopped) return;
    this.update({ noteNotice: text });
  }

  /**
   * Deletes several notes here at once, sent as batches of deletes. Once the relay has answered
   * for every one, `deleteReport` says how many went (and why any didn't). Not connected: nothing
   * is deleted, and the report says so.
   */
  deleteNotes(ids: readonly string[]): void {
    if (this.stopped) return;
    if (!this.live) return this.update({ deleteReport: DELETE_OFFLINE });
    let board = this.view.board;
    const ops: NoteBatchEntry[] = [];
    const run = this.deleteRun ?? { total: 0, ids: new Set<string>(), refs: new Set<string>(), refused: 0, tooQuick: false };
    const removed: Note[] = [];
    for (const id of ids) {
      const entry = findNote(board, id);
      if (!entry) continue;
      this.stopMove(id);
      this.stopResize(id);
      board = deleteLocal(board, id);
      run.total++;
      if (entry.clientRef !== null) {
        this.abandoned.add(entry.clientRef);
        run.refs.add(entry.clientRef);
      } else {
        ops.push({ op: "delete", id });
        removed.push(entry.note);
        run.ids.add(id);
      }
    }
    if (run.total > 0) this.deleteRun = run;
    this.update({ board, noteNotice: null });
    for (const ref of run.refs) this.history.refuse("note", localId(ref));
    this.recordRemoval(ids.length === 1 ? "Delete note" : "Delete notes", removed, []);
    this.sendBatch(ops, true);
  }

  /** The relay deleted a note (ours or someone else's): one fewer to hear about. */
  private deleteDone(id: string): void {
    this.deleteRun?.ids.delete(id);
  }

  /** Reports the delete once nothing in it is left to hear about. */
  private deleteSettled(): Partial<RoomView> {
    const run = this.deleteRun;
    if (!run || run.ids.size > 0 || run.refs.size > 0) return {};
    this.deleteRun = null;
    return { deleteReport: deleteReportFor({ ...run, lost: 0 }) };
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
    this.history.recordOrder(Date.now());
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
    this.history.recordAdd("Add frame", [{ kind: "frame", id: frame.id }], Date.now());
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
    if (Object.keys(edit).length > 0) {
      this.record("Edit frame", [{ kind: "frame", id, after: edit as Fields }]);
      this.send({ type: "frameEdit", id, ...edit });
    }
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
      this.recordRects("Move frame", ["frame", ...noteIds.map(() => "note" as const)], [id, ...noteIds], ["x", "y"]);
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
      this.recordRects("Resize frame", ["frame"], [id], ["x", "y", "w", "h"]);
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
    this.recordRects("Resize frame", ["frame"], [id], ["x", "y", "w", "h"]);
    this.sendFrameResize(id, true);
    return true;
  }

  /* ── Items with content (protocol v11) ──────────────────────────── */

  /**
   * Adds notes and frames with their full content (plain data), shown at once. They're packed
   * into itemsAdd messages by size (rooms/items.ts) and sent one every ITEMS_STEP_MS at most. Each
   * item gets its server id when the relay confirms it (onNoteConfirmed / onFrameConfirmed); a
   * refused item rolls back on its own, and once the relay has answered for every item a notice
   * says how many weren't added and why. Notes stack in the order given (last on top). Their local
   * ids in input order (null for one whose text is too long), or null if not connected.
   */
  addItems(inputs: readonly ItemInput[], label = "Add"): (string | null)[] | null {
    if (this.restoreRun) return null;
    const run = this.startItems(inputs, null, { record: label });
    if (!run) return null;
    if (run.pending.size === 0) this.update(this.itemsDone(run, this.view.board));
    return run.refs.map((ref) => (ref === null ? null : localId(ref)));
  }

  /**
   * Adds items locally and queues their itemsAdd messages. `record` names the history step (none
   * for a restore: the undo or redo is the step); `restore` marks an undo or redo's run; `defer`
   * leaves the sending to the caller (pumpItems), so the history knows the new ids first.
   */
  private startItems(
    inputs: readonly ItemInput[],
    template: number | null,
    { record = null, restore = false, defer = false }: { record?: string | null; restore?: boolean; defer?: boolean } = {},
  ): ItemsRun | null {
    if (!this.live || !this.view.you || inputs.length === 0) return null;
    const authorId = this.view.you.id;
    const run: ItemsRun = { refs: [], pending: new Set(), ids: new Map(), refused: { notesFull: 0, framesFull: 0, invalid: 0, tooQuick: 0 }, template, restore };
    let board = this.view.board;
    const drafts: ItemDraft[] = [];
    for (const input of inputs) {
      const ref = randomRef();
      if (input.kind === "note") {
        const { kind: _, x, y, w, h, text, ...style } = input;
        const clean = cleanNoteText(text);
        if (clean === null) {
          run.refs.push(null);
          run.refused.invalid++;
          continue;
        }
        // Sent as shown: whole units, clamped as the server will.
        const item: NoteItem = { ref, ...clampNoteRect({ x, y, w, h }), text: clean, ...style };
        board = addItemLocal(board, item, authorId);
        drafts.push({ kind: "note", item });
      } else {
        const { kind: _, x, y, w, h, title, ...style } = input;
        const clean = cleanFrameTitle(title);
        if (clean === null) {
          run.refs.push(null);
          run.refused.invalid++;
          continue;
        }
        const item: FrameItem = { ref, ...clampFrameRect({ x, y, w, h }), title: clean, ...style };
        board = addFrameItemLocal(board, item, authorId);
        drafts.push({ kind: "frame", item });
      }
      run.refs.push(ref);
      run.pending.add(ref);
    }
    const { messages, tooLarge } = packItems(drafts, randomRef);
    for (const { kind, item } of tooLarge) board = this.itemRefused(board, run, item.ref, kind, "invalid");
    for (const message of messages) {
      this.itemBatches.set(message.clientRef, { run, message, sent: false });
      this.itemQueue.push(message.clientRef);
    }
    if (restore) this.restoreRun = run;
    if (record !== null) {
      const kinds = new Map(drafts.map((d) => [d.item.ref, d.kind] as const));
      this.history.recordAdd(
        record,
        run.refs.flatMap((ref) => (ref !== null && run.pending.has(ref) ? [{ kind: kinds.get(ref) ?? "note", id: localId(ref) }] : [])),
        Date.now(),
      );
    }
    this.update({ board, noteNotice: null });
    if (!defer) this.pumpItems();
    return run;
  }

  /** Sends the next queued itemsAdd, then waits ITEMS_STEP_MS before the one after. */
  private pumpItems(): void {
    if (this.itemTimer !== undefined || !this.live) return;
    for (;;) {
      const clientRef = this.itemQueue.shift();
      if (clientRef === undefined) return;
      const batch = this.itemBatches.get(clientRef);
      // A batch cancelled meanwhile (its template ended) is skipped.
      if (!batch) continue;
      batch.sent = true;
      this.send(batch.message);
      this.itemTimer = setTimeout(() => {
        this.itemTimer = undefined;
        this.pumpItems();
      }, ITEMS_STEP_MS);
      return;
    }
  }

  /** The relay added a whole itemsAdd (ours: confirmed by ref and refused by index; anyone else's: just added), in one view update. */
  private itemsAdded(message: Extract<ServerMessage, { type: "itemsAdded" }>): void {
    let board = this.view.board;
    const batch = message.clientRef === undefined ? undefined : this.itemBatches.get(message.clientRef);
    if (!batch || message.clientRef === undefined) {
      for (const { note } of message.notes) board = applyAdded(board, note);
      for (const { frame } of message.frames) board = applyFrameAdded(board, frame);
      return this.update({ board });
    }
    this.itemBatches.delete(message.clientRef);
    const { run } = batch;
    for (const { ref, note } of message.notes) {
      if (ref === undefined) continue;
      board = this.confirmNote(board, note, ref);
      this.itemSettled(run, ref, findNote(board, note.id) ? note.id : null);
    }
    for (const { ref, frame } of message.frames) {
      if (ref === undefined) continue;
      board = this.confirmFrame(board, frame, ref);
      this.itemSettled(run, ref, findFrame(board, frame.id) ? frame.id : null);
    }
    for (const r of message.refused) {
      const ref = (r.kind === "note" ? batch.message.notes : batch.message.frames)?.[r.index]?.ref;
      if (ref !== undefined) board = this.itemRefused(board, run, ref, r.kind, r.reason);
    }
    // Anything the relay didn't account for can't be confirmed any more: rolled back.
    board = this.refuseUnanswered(board, batch, "invalid");
    this.update({ rateLimited: false, ...this.itemsDone(run, board) });
  }

  /** The relay refused a whole itemsAdd (nothing added, too quick, not joined): roll back each of its items. */
  private itemsErrored(message: Extract<ServerMessage, { type: "error" }>, batch: ItemsBatch): void {
    if (message.clientRef !== undefined) this.itemBatches.delete(message.clientRef);
    let board = this.view.board;
    for (const r of message.refused ?? []) {
      const ref = (r.kind === "note" ? batch.message.notes : batch.message.frames)?.[r.index]?.ref;
      if (ref !== undefined) board = this.itemRefused(board, batch.run, ref, r.kind, r.reason);
    }
    const reason = message.code === "notes_full" || message.code === "frames_full" || message.code === "rate_limited" ? message.code : "invalid";
    board = this.refuseUnanswered(board, batch, reason);
    this.update({ ...(message.code === "rate_limited" ? { rateLimited: true } : {}), ...this.itemsDone(batch.run, board) });
  }

  /** Rolls back the batch's items still pending, counting them under `reason`. */
  private refuseUnanswered(board: Board, batch: ItemsBatch, reason: ItemRefusalReason | "rate_limited"): Board {
    let next = board;
    for (const { ref } of batch.message.notes ?? []) if (batch.run.pending.has(ref)) next = this.itemRefused(next, batch.run, ref, "note", reason);
    for (const { ref } of batch.message.frames ?? []) if (batch.run.pending.has(ref)) next = this.itemRefused(next, batch.run, ref, "frame", reason);
    return next;
  }

  private itemSettled(run: ItemsRun, ref: string, id: string | null): void {
    run.pending.delete(ref);
    run.ids.set(ref, id);
  }

  /** One item wasn't added: it goes (unless it was deleted here meanwhile, which needs no notice). */
  private itemRefused(board: Board, run: ItemsRun, ref: string, kind: "note" | "frame", reason: ItemRefusalReason | "rate_limited"): Board {
    this.itemSettled(run, ref, null);
    this.history.refuse(kind, localId(ref));
    const deletedHere = kind === "note" ? this.abandoned.delete(ref) : this.abandonedFrames.delete(ref);
    if (deletedHere) this.deleteRun?.refs.delete(ref);
    else run.refused[refusalKey(reason)]++;
    return kind === "note" ? rejectAdd(board, ref) : rejectFrameAdd(board, ref);
  }

  /**
   * How a run ended, once the relay has answered for everything in it: a template ends (done, or
   * partial with what was made kept); otherwise a notice counts what wasn't added. A refusal in a
   * template ends it at once, and its batches not sent yet are dropped. A template that has ended
   * already says nothing more. The patch includes `board` (the one given, or with items dropped).
   */
  private itemsDone(run: ItemsRun, board: Board): Partial<RoomView> {
    const refused = refusedTotal(run.refused) > 0;
    if (run.restore) {
      if (run.pending.size > 0 || this.restoreRun !== run) return { board };
      this.restoreRun = null;
      const done = restoredCount(run);
      const total = run.refs.length;
      return {
        board,
        historyReport: refused
          ? { text: `${UNDO_TEXT.restoredPartly(done, total)} ${NOTICES.itemsNotAdded(run.refused)}`, partial: true }
          : { text: UNDO_TEXT.restored(done), partial: false },
      };
    }
    if (run.template !== null) {
      if (this.template?.run !== run) return { board };
      if (refused) return { board: this.cancelQueued(run, board), ...this.templateEnd("partial") };
      return { board, ...(run.pending.size === 0 ? this.templateEnd("done") : {}) };
    }
    if (run.pending.size > 0 || !refused) return { board };
    return { board, noteNotice: NOTICES.itemsNotAdded(run.refused) };
  }

  /** Drops the batches of `run` (or of every run) that haven't been sent, and their items here. */
  private cancelQueued(run: ItemsRun | null, from: Board): Board {
    let board = from;
    for (const [clientRef, batch] of [...this.itemBatches]) {
      if (batch.sent || (run !== null && batch.run !== run)) continue;
      this.itemBatches.delete(clientRef);
      for (const { ref } of batch.message.notes ?? []) {
        this.itemSettled(batch.run, ref, null);
        this.history.refuse("note", localId(ref));
        board = rejectAdd(board, ref);
      }
      for (const { ref } of batch.message.frames ?? []) {
        this.itemSettled(batch.run, ref, null);
        this.history.refuse("frame", localId(ref));
        board = rejectFrameAdd(board, ref);
      }
    }
    return board;
  }

  /* ── Duplicate ──────────────────────────────────────────────────── */

  /**
   * Duplicates these notes (canvas/duplicate.ts: full content, one offset clamped for the group,
   * on top in the originals' stacking order) through addItems. Refused, sending nothing, while
   * disconnected, for a note that's missing, unsaved or being moved here, while another add run is
   * being sent, or when the board hasn't room for every copy (a notice gives the counts). The
   * copies' local ids (in stacking order), or null.
   */
  duplicateNotes(ids: readonly string[]): string[] | null {
    if (!this.live || ids.length === 0) return null;
    const entries = ids.map((id) => findNote(this.view.board, id));
    if (entries.some((e) => !e || e.confirmed === null || isLocalId(e.note.id) || isHeld(e))) return null;
    const notes = entries.flatMap((e) => (e ? [e.note] : []));
    const free = Math.max(0, MAX_NOTES_PER_ROOM - this.view.board.notes.length);
    if (notes.length > free) {
      this.update({ noteNotice: NOTICES.duplicateNoRoom("note", notes.length, free) });
      return null;
    }
    if (this.itemBatches.size > 0) return null;
    return this.addItems(duplicateNoteInputs(notes), "Duplicate")?.flatMap((id) => (id === null ? [] : [id])) ?? null;
  }

  /** Duplicates a frame alone (never its notes) through addItems, likewise. The copy's local id, or null. */
  duplicateFrame(id: string): string | null {
    const entry = findFrame(this.view.board, id);
    if (!this.live || !entry || entry.confirmed === null || isLocalId(id) || isFrameHeld(entry)) return null;
    const free = Math.max(0, MAX_FRAMES_PER_ROOM - this.view.board.frames.length);
    if (free < 1) {
      this.update({ noteNotice: NOTICES.duplicateNoRoom("frame", 1, free) });
      return null;
    }
    if (this.itemBatches.size > 0) return null;
    return this.addItems([duplicateFrameInput(entry.frame)], "Duplicate")?.[0] ?? null;
  }

  /* ── Undo and redo (history/history.ts) ─────────────────────────── */

  /** Undoes my last action (what someone else changed since is left as it is). */
  undo(): void {
    this.runHistory("undo");
  }

  /** Redoes what I last undid. */
  redo(): void {
    this.runHistory("redo");
  }

  /** Why undo and redo are off now, or null each. */
  private historyReasons(): { undo: string | null; redo: string | null } {
    if (!this.live) return { undo: UNDO_TEXT.offline, redo: UNDO_TEXT.offline };
    if (this.restoreRun || this.itemBatches.size > 0) return { undo: UNDO_TEXT.busy, redo: UNDO_TEXT.busy };
    const now = Date.now();
    return { undo: this.history.undoReason(now), redo: this.history.redoReason(now) };
  }

  /** An item as the relay last stored it, for the history's rev check. A note being typed into, or held, can't change. */
  private readonly lookup: Lookup = (kind, id) => {
    if (kind === "note") {
      const entry = findNote(this.view.board, id);
      if (!entry?.confirmed) return null;
      return { rev: entry.confirmed.rev, held: isHeld(entry) || entry.draft !== null, state: entry.confirmed as unknown as Fields };
    }
    const entry = findFrame(this.view.board, id);
    if (!entry?.confirmed) return null;
    return { rev: entry.confirmed.rev, held: isFrameHeld(entry) || entry.draft !== null, state: entry.confirmed as unknown as Fields };
  };

  /**
   * Runs the history's plan with the existing messages: rects as final batches (notes) or
   * frameMove/frameResize, other fields as noteEdit/frameEdit, deletes as batch deletes and
   * frameDelete, and items to add back through a paced addItems run (new ids, me as author). The
   * history learns the new ids before anything is sent, so the relay's answers find them.
   */
  private runHistory(direction: "undo" | "redo"): void {
    if (this.historyReasons()[direction] !== null) return;
    const now = Date.now();
    const plan: Plan = this.history.plan(direction, this.lookup, now);
    if (plan.type === "none") return;
    if (plan.type === "order") {
      this.history.applied(plan, new Map(), now);
      return this.update({ noteNotice: null, historyReport: { text: plan.message, partial: false } });
    }
    let board = this.view.board;
    // Items to add back: shown at once (local ids); sent once the history knows them.
    const newIds = new Map<string, string>();
    let restore: ItemsRun | null = null;
    if (plan.restores.length > 0) {
      const inputs = plan.restores.map((r) => ({ kind: r.kind, ...r.content }) as unknown as ItemInput);
      restore = this.startItems(inputs, null, { restore: true, defer: true });
      board = this.view.board;
      plan.restores.forEach((r, i) => {
        const ref = restore?.refs[i];
        if (ref) newIds.set(`${r.kind}:${r.id}`, localId(ref));
      });
    }
    this.history.applied(plan, newIds, now);

    const ops: NoteBatchEntry[] = [];
    const sends: ClientMessage[] = [];
    for (const { kind, id, values } of plan.changes) {
      const { x, y, w, h, ...fields } = values as Fields & Partial<NoteRect>;
      const hasRect = x !== undefined || y !== undefined || w !== undefined || h !== undefined;
      if (kind === "note") {
        const before = findNote(board, id)?.note;
        if (!before) continue;
        if (hasRect) {
          const rect = { x: x ?? before.x, y: y ?? before.y, w: w ?? before.w, h: h ?? before.h };
          board = resizeLocal(board, id, rect);
          const after = findNote(board, id)?.note ?? before;
          ops.push(w === undefined && h === undefined ? { op: "move", id, x: after.x, y: after.y } : { op: "resize", id, x: after.x, y: after.y, w: after.w, h: after.h });
        }
        const { text, ...style } = fields as Partial<Note>;
        if (text !== undefined) board = editLocal(board, id, text);
        if (Object.keys(style).length > 0) board = styleLocal(board, id, style as StylePatch);
        if (text !== undefined || Object.keys(style).length > 0) sends.push({ type: "noteEdit", id, ...(fields as Partial<Note>) });
        continue;
      }
      const before = findFrame(board, id)?.frame;
      if (!before) continue;
      if (w !== undefined || h !== undefined) {
        board = resizeFrameLocal(board, id, { x: x ?? before.x, y: y ?? before.y, w: w ?? before.w, h: h ?? before.h });
        const f = findFrame(board, id)?.frame ?? before;
        sends.push({ type: "frameResize", id, x: f.x, y: f.y, w: f.w, h: f.h, final: true });
      } else if (hasRect) {
        board = moveFrameLocal(board, id, x ?? before.x, y ?? before.y);
        const f = findFrame(board, id)?.frame ?? before;
        sends.push({ type: "frameMove", id, x: f.x, y: f.y, final: true });
      }
      if (Object.keys(fields).length > 0) {
        board = editFrameLocal(board, id, fields as FrameEdit);
        sends.push({ type: "frameEdit", id, ...(fields as FrameEdit) });
      }
    }
    for (const { kind, id } of plan.deletes) {
      if (kind === "note") {
        this.stopMove(id);
        this.stopResize(id);
        board = deleteLocal(board, id);
        ops.push({ op: "delete", id });
      } else {
        this.stopFrameMove(id);
        this.stopFrameResize(id);
        board = deleteFrameLocal(board, id);
        sends.push({ type: "frameDelete", id });
      }
    }
    this.update({
      board,
      noteNotice: null,
      historyReport: plan.skipped > 0 ? { text: HISTORY_TEXT.conflicts(plan.skipped), partial: true } : null,
    });
    this.sendBatch(ops, true);
    for (const message of sends) this.send(message);
    if (restore) {
      if (restore.pending.size === 0) this.update(this.itemsDone(restore, this.view.board));
      this.pumpItems();
    }
  }

  /** Records my change to some items (only those the relay has confirmed): `after` is what was sent. */
  private record(label: string, changes: readonly { kind: ItemKind; id: string; after: Fields }[], coalesce?: string): void {
    const list = changes.flatMap((c) => {
      const before = this.storedFields(c.kind, c.id, Object.keys(c.after));
      return before ? [{ ...c, before }] : [];
    });
    this.history.recordChange(label, list, Date.now(), coalesce);
  }

  /** Records rect fields of items as they're shown now (after a local move or resize). */
  private recordRects(label: string, kinds: readonly ItemKind[], ids: readonly string[], keys: readonly (keyof NoteRect)[], coalesce?: string): void {
    const changes = ids.flatMap((id, i) => {
      const kind = kinds[i] ?? "note";
      const shown: NoteRect | undefined = kind === "note" ? findNote(this.view.board, id)?.note : findFrame(this.view.board, id)?.frame;
      return shown ? [{ kind, id, after: Object.fromEntries(keys.map((k) => [k, shown[k]])) }] : [];
    });
    this.record(label, changes, coalesce);
  }

  /** What the relay has (or will have, from my changes in flight) for these fields; null for an unconfirmed item. */
  private storedFields(kind: ItemKind, id: string, keys: readonly string[]): Fields | null {
    const confirmed = (kind === "note" ? findNote(this.view.board, id)?.confirmed : findFrame(this.view.board, id)?.confirmed) as unknown as Fields | null | undefined;
    if (!confirmed) return null;
    const pending = this.history.pendingValues(kind, id);
    return Object.fromEntries(keys.flatMap((k) => {
      const v = pending[k] ?? confirmed[k];
      return v === undefined ? [] : [[k, v]];
    }));
  }

  /** Records items I deleted (confirmed only), with their content and z, to add them back on undo. */
  private recordRemoval(label: string, notes: readonly Note[], frames: readonly Frame[]): void {
    const rev = (kind: ItemKind, id: string) =>
      (kind === "note" ? (findNote(this.view.board, id) ?? this.view.board.removed.find((n) => n.note.id === id))?.confirmed?.rev : (findFrame(this.view.board, id) ?? this.view.board.framesRemoved.find((f) => f.frame.id === id))?.confirmed?.rev) ?? 1;
    this.history.recordRemove(
      label,
      [
        ...notes.filter((n) => !isLocalId(n.id)).map((n) => ({ kind: "note" as const, id: n.id, content: n as unknown as Fields, z: n.z, rev: rev("note", n.id) })),
        ...frames.filter((f) => !isLocalId(f.id)).map((f) => ({ kind: "frame" as const, id: f.id, content: f as unknown as Fields, z: 0, rev: rev("frame", f.id) })),
      ],
      Date.now(),
    );
  }

  /**
   * Tells the history what the relay stored, by comparing the board before and after a message:
   * confirmed items whose stored version changed (with whether only z did), and items that left.
   */
  private observe(before: Board, after: Board): void {
    if (before === after) return;
    const notesBefore = new Map([...before.notes, ...before.removed].map((n) => [n.note.id, n.confirmed] as const));
    const notesAfter = new Map([...after.notes, ...after.removed].map((n) => [n.note.id, n.confirmed] as const));
    for (const [id, confirmed] of notesAfter) {
      const prev = notesBefore.get(id);
      if (!confirmed || !prev || prev === confirmed) continue;
      const zOnly = (Object.keys(confirmed) as (keyof Note)[]).every((k) => k === "z" || k === "rev" || confirmed[k] === prev[k]);
      this.history.observe("note", id, prev.rev, confirmed.rev, confirmed as unknown as Fields, zOnly);
    }
    for (const id of notesBefore.keys()) if (!notesAfter.has(id) && !isLocalId(id)) this.history.deleted("note", id);
    const framesBefore = new Map([...before.frames, ...before.framesRemoved].map((f) => [f.frame.id, f.confirmed] as const));
    const framesAfter = new Map([...after.frames, ...after.framesRemoved].map((f) => [f.frame.id, f.confirmed] as const));
    for (const [id, confirmed] of framesAfter) {
      const prev = framesBefore.get(id);
      if (!confirmed || !prev || prev === confirmed) continue;
      this.history.observe("frame", id, prev.rev, confirmed.rev, confirmed as unknown as Fields, false);
    }
    for (const id of framesBefore.keys()) if (!framesAfter.has(id) && !isLocalId(id)) this.history.deleted("frame", id);
    // A change confirmed may make undo or redo possible.
    this.refreshHistory();
  }

  /** Reports undo and redo's reasons if they changed (a step recorded, or confirmed). */
  private refreshHistory(): void {
    if (this.stopped) return;
    const reasons = this.historyReasons();
    if (reasons.undo === this.view.history.undo && reasons.redo === this.view.history.redo) return;
    this.view = { ...this.view, history: reasons };
    this.options.onChange(this.view);
  }

  /* ── Templates ──────────────────────────────────────────────────── */

  /**
   * Applies a template: its frames, each at its place and size with its title, colour and title
   * style, through addItems (one message for every template there is today, so they appear at
   * once). Existing frames and notes are never touched. Refused (and nothing sent) while
   * disconnected, while another template is being applied, or when the board hasn't enough free
   * frame slots (a notice says how many it needs and has). A refusal or a lost connection
   * part-way ends it: what was made stays, one notice says so, nothing is retried.
   */
  applyTemplate(frames: readonly TemplateFramePlan[]): boolean {
    if (!this.live || this.template || this.restoreRun || frames.length === 0) return false;
    const free = Math.max(0, MAX_FRAMES_PER_ROOM - this.view.board.frames.length);
    if (frames.length > free) {
      this.update({ noteNotice: NOTICES.templateNoRoom(frames.length, free) });
      return false;
    }
    const seq = ++this.templateSeq;
    const run = this.startItems(
      frames.map((plan) => ({ kind: "frame" as const, x: plan.x, y: plan.y, w: plan.w, h: plan.h, title: plan.title, color: plan.color, ...FRAME_DEFAULTS, ...plan.style })),
      seq,
      { record: "Template" },
    );
    if (!run) return false;
    this.template = { seq, run };
    this.update({ template: { seq, state: "applying", frameIds: [] }, ...(run.pending.size === 0 ? this.itemsDone(run, this.view.board) : {}) });
    return true;
  }

  /** Ends the template being applied: its frames that were made (server ids, in template order). */
  private templateEnd(state: "done" | "partial"): Partial<RoomView> {
    const apply = this.template;
    if (!apply) return {};
    this.template = null;
    const frameIds = apply.run.refs.flatMap((ref) => {
      const id = ref === null ? null : apply.run.ids.get(ref);
      return id ? [id] : [];
    });
    return { template: { seq: apply.seq, state, frameIds }, ...(state === "partial" ? { noteNotice: NOTICES.templatePartial } : {}) };
  }

  /** Deletes a frame here at once. Never its notes. */
  deleteFrame(id: string): void {
    if (!this.live) return;
    const entry = findFrame(this.view.board, id);
    if (!entry) return;
    this.stopFrameMove(id);
    this.stopFrameResize(id);
    this.update({ board: deleteFrameLocal(this.view.board, id), noteNotice: null });
    if (entry.clientRef !== null) {
      this.abandonedFrames.add(entry.clientRef);
      this.history.refuse("frame", id);
    } else {
      this.recordRemoval("Delete frame", [], [entry.frame]);
      this.send({ type: "frameDelete", id });
    }
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
    clearTimeout(this.itemTimer);
    this.template = null;
    this.restoreRun = null;
    this.history.clear();
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
      const run = this.deleteRun;
      this.deleteRun = null;
      const lost = run ? run.ids.size + run.refs.size : 0;
      // Items not sent yet never will be: they go. Those in flight stay, like any add in flight.
      clearTimeout(this.itemTimer);
      this.itemTimer = undefined;
      this.itemQueue = [];
      const restore = this.restoreRun;
      this.restoreRun = null;
      const board = this.cancelQueued(null, this.view.board);
      this.itemBatches.clear();
      // Ids and revs can't be trusted after this: the history goes.
      this.history.clear();
      // A template cut off part-way: what was made stays, and the notice says so.
      this.update({
        status: "disconnected",
        board,
        ...(run ? { deleteReport: deleteReportFor({ ...run, lost }) } : {}),
        ...(restore ? { historyReport: { text: UNDO_TEXT.restoreLost(restoredCount(restore), restore.refs.length), partial: true } } : {}),
        ...this.templateEnd("partial"),
      });
      return;
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
    const before = this.view.board;
    this.handle(parsed.value);
    this.observe(before, this.view.board);
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
        // A (re)sync: what the history knows about ids and revs can't be trusted any more.
        this.history.clear();
        return this.update({ board: applySnapshot(this.view.board, message.notes), synced: true });

      case "noteAdded": {
        const { note, clientRef } = message;
        return this.update({ board: this.confirmNote(this.view.board, note, clientRef), ...(clientRef !== undefined ? { rateLimited: false } : {}) });
      }

      case "itemsAdded":
        return this.itemsAdded(message);

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
            this.deleteDone(result.id);
          }
        }
        return this.update({ board, ...(editingDeleted ? { noteNotice: NOTICES.deletedWhileEditing } : {}), ...this.deleteSettled() });
      }

      case "notesOrdered":
        // One view update for every restacked note.
        return this.update({ board: applyOrdered(this.view.board, message.results) });

      case "framesSnapshot":
        // Right after the notes snapshot. The board is already joined and drawn; frames slot in behind.
        return this.update({ board: applyFramesSnapshot(this.view.board, message.frames) });

      case "frameAdded": {
        const { frame, clientRef } = message;
        return this.update({ board: this.confirmFrame(this.view.board, frame, clientRef), ...(clientRef !== undefined ? { rateLimited: false } : {}) });
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
        this.deleteDone(message.id);
        return this.update({
          board: applyDeleted(this.view.board, message.id),
          ...(editing ? { noteNotice: NOTICES.deletedWhileEditing } : {}),
          ...this.deleteSettled(),
        });
      }

      case "error": {
        const batch = message.clientRef === undefined ? undefined : this.itemBatches.get(message.clientRef);
        if (batch) return this.itemsErrored(message, batch);
        if (message.clientRef !== undefined || message.noteId !== undefined || message.noteIds !== undefined || message.frameId !== undefined) {
          return this.noteRefused(message);
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
  }

  /**
   * A note add confirmed (a noteAdd's, or an itemsAdd entry's by its ref): the temporary note takes
   * its server id. Deleted here meanwhile: deleted now. Text or style committed meanwhile: one edit.
   */
  private confirmNote(board: Board, note: Note, clientRef: string | undefined): Board {
    const temp = clientRef === undefined ? undefined : findNote(board, localId(clientRef));
    let next = applyAdded(board, note, clientRef);
    if (clientRef !== undefined && this.abandoned.delete(clientRef)) {
      // Deleted here before the server confirmed it.
      next = deleteLocal(next, note.id);
      this.send({ type: "noteDelete", id: note.id });
      if (this.deleteRun?.refs.delete(clientRef)) this.deleteRun.ids.add(note.id);
    } else if (temp) {
      this.history.confirmAdd("note", temp.note.id, note.id, note.rev);
      // Text, colour or style committed while the add was in flight: one edit with all of it.
      const edit = { ...(temp.note.text !== note.text ? { text: temp.note.text } : {}), ...styleChanges(note, temp.note) };
      if (Object.keys(edit).length > 0) {
        this.history.expectOwn("note", note.id, edit as Fields, Date.now());
        this.send({ type: "noteEdit", id: note.id, ...edit });
      }
    }
    if (temp) this.options.onNoteConfirmed?.(temp.note.id, note.id);
    return next;
  }

  /** A frame add confirmed (a frameAdd's, or an itemsAdd entry's by its ref), likewise. */
  private confirmFrame(board: Board, frame: Frame, clientRef: string | undefined): Board {
    const temp = clientRef === undefined ? undefined : findFrame(board, localId(clientRef));
    let next = applyFrameAdded(board, frame, clientRef);
    if (clientRef !== undefined && this.abandonedFrames.delete(clientRef)) {
      next = deleteFrameLocal(next, frame.id);
      this.send({ type: "frameDelete", id: frame.id });
    } else if (temp) {
      this.history.confirmAdd("frame", temp.frame.id, frame.id, frame.rev);
      // A title, colour or title style set while the add was in flight: one edit with all of it.
      const edit = frameChanges(frame, temp.frame);
      if (Object.keys(edit).length > 0) {
        this.history.expectOwn("frame", frame.id, edit as Fields, Date.now());
        this.send({ type: "frameEdit", id: frame.id, ...edit });
      }
    }
    if (temp) this.options.onFrameConfirmed?.(temp.frame.id, frame.id);
    return next;
  }

  /** The server refused a note or frame change: roll it back and say why. */
  private noteRefused(message: Extract<ServerMessage, { type: "error" }>): void {
    let board = this.view.board;
    const noteIds = [...(message.noteId !== undefined ? [message.noteId] : []), ...(message.noteIds ?? [])];
    // Refusals that only touch a delete in flight are told in its report, not as a notice.
    const run = this.deleteRun;
    let ours = run !== null && message.frameId === undefined && (message.clientRef !== undefined || noteIds.length > 0);
    if (run && message.clientRef !== undefined) {
      // A refused add that was deleted here anyway: gone, as asked.
      if (!run.refs.delete(message.clientRef)) ours = false;
    }
    if (run) {
      for (const id of noteIds) {
        if (run.ids.delete(id)) {
          run.refused++;
          run.tooQuick ||= message.code === "rate_limited";
        } else ours = false;
      }
    }
    if (message.clientRef !== undefined) {
      this.history.refuse("note", localId(message.clientRef));
      this.history.refuse("frame", localId(message.clientRef));
      // A clientRef belongs to one add, a note's or a frame's.
      this.abandoned.delete(message.clientRef);
      this.abandonedFrames.delete(message.clientRef);
      board = rejectFrameAdd(rejectAdd(board, message.clientRef), message.clientRef);
    }
    if (message.frameId !== undefined) {
      this.history.refuse("frame", message.frameId);
      this.stopFrameMove(message.frameId);
      this.stopFrameResize(message.frameId);
      if (this.frameDrag?.id === message.frameId) this.frameDrag = null;
      board = rollbackFrame(board, message.frameId);
    }
    // One note, or the notes a refused batch named (the rest of the batch stands). Last first, so
    // notes deleted together go back in their old places.
    for (const id of [...noteIds].reverse()) {
      this.history.refuse("note", id);
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
    this.update({
      board,
      ...(ours ? {} : { noteNotice }),
      ...(message.code === "rate_limited" ? { rateLimited: true } : {}),
      ...this.deleteSettled(),
    });
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
    // Anything sent may have been recorded just before.
    this.refreshHistory();
  }

  private update(patch: Partial<RoomView>): void {
    // A note action (it clears the notice) also clears the last delete's report.
    if (patch.noteNotice === null && !("deleteReport" in patch)) patch = { ...patch, deleteReport: null };
    if (patch.noteNotice === null && !("historyReport" in patch)) patch = { ...patch, historyReport: null };
    const restore = this.restoreRun;
    this.view = {
      ...this.view,
      ...patch,
      adding: this.itemBatches.size > 0,
      ...(restore ? { historyReport: { text: UNDO_TEXT.restoring(restoredCount(restore), restore.refs.length), partial: false } } : {}),
    };
    this.view = { ...this.view, history: this.historyReasons() };
    this.options.onChange(this.view);
  }
}
