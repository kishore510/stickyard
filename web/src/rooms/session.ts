import {
  FRAME_DEFAULTS,
  FRAME_STYLE_FIELDS,
  MAX_BATCH_ENTRIES,
  MAX_FRAMES_PER_ROOM,
  MAX_NOTES_PER_ROOM,
  MAX_SERVER_MESSAGE_BYTES,
  MAX_SHAPES_PER_ROOM,
  PROTOCOL_VERSION,
  ROOM_ENDED_CLOSE_CODE,
  ROOM_EXPIRED_CLOSE_CODE,
  ROOM_IDLE_EXPIRY_DAYS,
  MAX_VOTERS_PER_ROUND,
  VOTE_BUDGET_DEFAULT,
  VOTE_BUDGET_MAX,
  VOTE_BUDGET_MIN,
  clampFramePosition,
  clampFrameRect,
  clampNoteRect,
  clampShapeRect,
  cleanFrameTitle,
  cleanName,
  cleanNoteText,
  cleanShapeText,
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
  type Shape,
  type ShapeBatchEntry,
  type ShapeItem,
  type ShapeKind,
  type TimerState,
  type VotingState,
} from "@stickyard/shared";
import {
  LIMIT_MAX_PROBES,
  LIMIT_RETRY_MS,
  MIN_TRY_GAP_MS,
  RECONNECT_MAX_ATTEMPTS,
  STATIC_ENV,
  afterFailedTry,
  backoffDelay,
  mayTryWhileHidden,
  shouldProbe,
  type ConnectionEnv,
  type ProbeResult,
} from "../connection/reconnect";
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
  type BoardFrame,
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
  type BoardNote,
  type StylePatch,
} from "../notes/board";
import {
  type BoardShape,
  addShapeItemLocal,
  addShapeLocal,
  applyShapeAdded,
  applyShapeDeleted,
  applyShapeMoved,
  applyShapeResized,
  applyShapeUpdated,
  applyShapesSnapshot,
  deleteShapeLocal,
  editShapeLocal,
  findShape,
  isShapeHeld,
  moveShapeLocal,
  rejectShapeAdd,
  resizeShapeLocal,
  resyncShapes,
  rollbackShape,
  setShapeDraft,
  setShapeDragging,
  setShapeResizing,
  shapeChanges,
  type ShapeEdit,
} from "../shapes/board";
import { carryPlan } from "../canvas/frameSelect";
import { DUPLICATE_HINTS, duplicateFrameInput, duplicateNoteInputs, duplicateSelectionInputs } from "../canvas/duplicate";
import { HISTORY_TEXT, History, type Fields, type ItemKind, type Lookup, type Plan } from "../history/history";
import type { CodeCheck } from "./api";
import { packItems, type ItemDraft, type ItemsAddMessage } from "./items";
import { validDuration } from "../timer/timer";
import { LOCK_TEXT, lockedOut } from "../facilitation/lock";
import { LEAVE_GRACE_MS, RESYNC_QUIET_MS, TOAST_BATCH_MS, TOAST_GAP_MS, TOAST_SHOW_MS, summarizePresence, type PresenceEvent } from "../presence/toasts";
import { discardUnconfirmed, resyncFrames, resyncNotes, unsavedKeys, type OrphanDraft } from "./resync";
import type { CursorSink } from "../cursors/cursors";

/*
 * One visit to a room: connect, hello, join, then follow participants, echoes and notes.
 * Everything the server sends is validated against the shared schema; anything this page
 * can't understand means it is out of date ("reload"). Names and text are kept as plain
 * strings and only ever rendered as text.
 *
 * Notes are optimistic: local changes show at once and roll back if the server refuses them
 * (see notes/board.ts). Editing needs a live connection; there's no offline queue (decided).
 *
 * Reconnect: once joined, a dropped connection is retried on its own (connection/reconnect.ts:
 * backoff with jitter, a cap on tries, a slow health probe when the relay looks down) in this same
 * session, so the board stays on screen, read-only. At the drop the board goes back to what the
 * relay last confirmed (one notice counts what may not have been saved); on reconnect the
 * relay's snapshots replace it (rooms/resync.ts). Drafts being typed are kept.
 */

/**
 * `expired`: the relay closed the socket with ROOM_EXPIRED_CLOSE_CODE (4410): nobody was in the
 * room for ROOM_IDLE_EXPIRY_DAYS, so it was deleted. Final: no retries, no probes, no Rejoin.
 */
export type RoomStatus = "idle" | "connecting" | "joined" | "invalid" | "full" | "reload" | "unreachable" | "disconnected" | "expired" | "ended";

/** What the page says about a session a host ended (protocol v12, close code 4411). */
export const ENDED_TEXT = {
  title: "Session ended",
  body: "This session was ended by the host.",
  home: "Go to the start page",
} as const;

/** The room's timer here: the relay's start and length, and the relay's clock minus this device's. */
export interface RoomTimer {
  startedAt: number;
  durationMs: number;
  offsetMs: number;
}

/** The timer from the relay's message: its clock offset is worked out from serverNow on arrival. */
export function roomTimer(timer: TimerState | null, now = Date.now()): RoomTimer | null {
  return timer ? { startedAt: timer.startedAt, durationMs: timer.durationMs, offsetMs: timer.serverNow - now } : null;
}

/** Milliseconds left at this device's `now` (0 once it has run out). */
export function timerRemainingMs(timer: RoomTimer, now: number): number {
  return Math.max(0, timer.startedAt + timer.durationMs - (now + timer.offsetMs));
}

/** What the page says about an expired session. */
export const EXPIRED_TEXT = {
  title: "Session expired",
  body: `This session has expired because nobody used it for ${ROOM_IDLE_EXPIRY_DAYS} days. Start a new session from the start page.`,
  home: "Go to the start page",
} as const;

/**
 * While disconnected after having joined: `reconnecting` (try `attempt` of `max` is waiting or
 * running), `network` (the browser says it's offline: waiting for it), `offline` (automatic tries
 * used up: Rejoin), `full` (the session filled up meanwhile: Rejoin), `limit` (the relay may be
 * unreachable or over its daily limit: a probe a minute, and Rejoin).
 */
export type ReconnectPhase = "reconnecting" | "network" | "offline" | "full" | "limit";
export interface ReconnectView {
  phase: ReconnectPhase;
  attempt: number;
  max: number;
}

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
  /** A join/leave toast (plain text, batched; presence/toasts.ts), until it times out. */
  presenceToast: { seq: number; text: string } | null;
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
  /** Clear board is still deleting (another waits); its outcome is `deleteReport`. */
  clearing: boolean;
  /** A delete of a selection with frames is still running (v0.20.0). */
  deleting: boolean;
  /** Reconnecting after a drop (null while joined, and before the first join). */
  reconnect: ReconnectView | null;
  /** How many changes may not have been saved when the connection dropped, until the next note action. */
  dropReport: string | null;
  /** Text typed into a note that's gone (it was still being added at the drop, or the resync didn't have it). */
  orphanDraft: OrphanDraft | null;
  /** Every participant id you've had in this visit (a reconnect gives a new one): your notes stay yours. */
  yourIds: ReadonlySet<string>;
  /** Protocol v12: this visit has host powers (the relay granted claimHost). */
  isHost: boolean;
  /** Protocol v12: the host has locked the board (only hosts can change it). */
  locked: boolean;
  /** Protocol v12: the room's timer, or null. */
  timer: RoomTimer | null;
  /** The lock the host asked for, until the relay answers (null: not waiting). Not optimistic. */
  lockPending: boolean | null;
  /** Protocol v13: the room's dot voting state. */
  voting: VotingState;
  /** Protocol v13: the relay granted this visit a voter (claimVoter with this device's key). */
  isVoter: boolean;
  /** My dots this round, by note id (votes waiting for the relay shown already; the relay confirms or rolls them back). */
  myVotes: ReadonlyMap<string, number>;
  /** Dots I have left this round. */
  remaining: number;
  /** The relay said this round has its maximum of voters (claimVoter or a vote refused with voters_full). */
  votersFull: boolean;
  /** The round's totals (non-zero, in note creation order), only while voting is closed. Never who voted. */
  results: readonly VoteTotal[] | null;
}

/** One note's dots in a closed round's results. */
export interface VoteTotal {
  noteId: string;
  count: number;
}

export const VOTING_OFF: VotingState = { state: "off", budget: VOTE_BUDGET_DEFAULT, round: 0 };

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
  presenceToast: null,
  board: EMPTY_BOARD,
  noteNotice: null,
  deleteReport: null,
  synced: false,
  template: null,
  people: new Map(),
  adding: false,
  history: { undo: "Not connected.", redo: "Not connected." },
  historyReport: null,
  clearing: false,
  deleting: false,
  reconnect: null,
  dropReport: null,
  orphanDraft: null,
  yourIds: new Set(),
  isHost: false,
  locked: false,
  timer: null,
  lockPending: null,
  voting: VOTING_OFF,
  isVoter: false,
  myVotes: new Map(),
  remaining: VOTE_BUDGET_DEFAULT,
  votersFull: false,
  results: null,
};

/** What a dropped connection says about changes it may have lost. */
export const DROP_TEXT = {
  unsaved: (n: number) => `${n} ${n === 1 ? "change" : "changes"} may not have been saved because the connection dropped.`,
} as const;

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
 * A selection with frames being dragged (v0.20.0): live updates go out at most this often, at
 * most SELECTION_LIVE_MESSAGES messages each time (a batch of the loose notes, up to
 * MAX_BATCH_ENTRIES, and frames taking turns, each with the notes it carries). That's 20 messages
 * a second, under the relay's SOCKET_LIMITS (30 a second, burst 40) whatever the selection, and at
 * most 500 entries a second (only the batch has entries live), under BATCH_LIMITS (600 a second).
 * Here everything moves on every pointer move; the drop sends every frame and note once.
 */
export const SELECTION_MOVE_INTERVAL_MS = 100;
export const SELECTION_LIVE_MESSAGES = 2;

/**
 * itemsAdd messages (addItems, templates) go out at most this many a second: a third of the
 * relay's SOCKET_LIMITS (30 a second, burst 40), so typing or dragging at the same time still
 * fits. At most MAX_BATCH_ENTRIES items each, so at most 500 entries a second, inside BATCH_LIMITS
 * (600 a second).
 */
export const ITEMS_MESSAGES_PER_SECOND = 10;
/** The gap between itemsAdd messages. */
export const ITEMS_STEP_MS = 1000 / ITEMS_MESSAGES_PER_SECOND;

/**
 * Clear board sends one frameDelete this often (20 a second): with its four batches of note
 * deletes, inside the relay's SOCKET_LIMITS (30 a second, burst 40).
 */
export const CLEAR_FRAME_STEP_MS = 50;

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

/**
 * Plain data for addItems: a note, a frame or a shape with its full content (no id, ref, rev, z or
 * author). A shape's own kind (text, rect, oval, diamond) is `shapeKind`.
 */
export type ItemInput =
  | ({ kind: "note" } & Omit<NoteItem, "ref" | "rank">)
  | ({ kind: "frame" } & Omit<FrameItem, "ref">)
  | ({ kind: "shape"; shapeKind: ShapeKind } & Omit<ShapeItem, "ref" | "rank" | "kind">);

/** An item's content (as the history keeps it) as addItems input. */
function itemInput(kind: ItemKind, content: Fields): ItemInput {
  if (kind === "shape") {
    const { kind: shapeKind, ...rest } = content;
    return { kind: "shape", shapeKind, ...rest } as unknown as ItemInput;
  }
  return { kind, ...content } as unknown as ItemInput;
}

/** Items that weren't added, by why. */
export interface ItemsRefused {
  notesFull: number;
  framesFull: number;
  shapesFull: number;
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
  shapeDeletedWhileEditing: "Someone else deleted the shape you were editing.",
  locked: "The host has locked the board.",
  notHost: "Only the host can do that.",
  overBudget: "You’ve placed all your dots. Take one off another note first.",
  votingClosed: "Voting isn’t open right now.",
  noVoter: "Your vote couldn’t be counted. Leave and rejoin the session to vote.",
  votersFull: `This round already has the maximum of ${MAX_VOTERS_PER_ROUND} voters.`,
  voteOffline: "You’re not connected, so your vote wasn’t counted.",
  framesFull: `The board has the maximum of ${MAX_FRAMES_PER_ROOM} frames. Delete a frame to add another.`,
  shapesFull: `The board has the maximum of ${MAX_SHAPES_PER_ROOM} shapes and text boxes. Delete one to add another.`,
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
function itemsNotice({ notesFull, framesFull, shapesFull, invalid, tooQuick }: ItemsRefused): string {
  const parts: string[] = [];
  if (notesFull > 0) parts.push(`${plural(notesFull, "note")} because the board is full (${MAX_NOTES_PER_ROOM} notes).`);
  if (framesFull > 0) parts.push(`${plural(framesFull, "frame")} because the board has the maximum of ${MAX_FRAMES_PER_ROOM} frames.`);
  if (shapesFull > 0) parts.push(`${plural(shapesFull, "shape")} because the board has the maximum of ${MAX_SHAPES_PER_ROOM} shapes.`);
  if (tooQuick > 0) parts.push(`${plural(tooQuick, "item")} because that was too quick. Try again.`);
  if (invalid > 0) parts.push(`${plural(invalid, "item")} because the relay refused ${invalid === 1 ? "it" : "them"}.`);
  return parts.join(" ");
}

/** Items of a run the relay has added. */
const restoredCount = (run: ItemsRun) => [...run.ids.values()].filter((id) => id !== null).length;

const refusedTotal = (r: ItemsRefused) => r.notesFull + r.framesFull + r.shapesFull + r.invalid + r.tooQuick;

/** Which ItemsRefused count a refusal adds to. */
function refusalKey(reason: ItemRefusalReason | "rate_limited"): keyof ItemsRefused {
  if (reason === "notes_full") return "notesFull";
  if (reason === "frames_full") return "framesFull";
  if (reason === "shapes_full") return "shapesFull";
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

/**
 * Clear board, or a delete of a selection with frames (v0.20.0), in flight: per kind, what the
 * relay hasn't answered for yet, and what it refused.
 */
interface ClearRun {
  kind: "clear" | "delete";
  notes: ClearPart;
  frames: ClearPart & { queue: string[] };
  /** Shapes (protocol v15): deleted in shapeBatch chunks, like notes. */
  shapes: ClearPart;
}
interface ClearPart {
  total: number;
  /** Server ids waiting for the relay. */
  ids: Set<string>;
  /** Adds deleted before they were confirmed (their clientRefs). */
  refs: Set<string>;
  refused: number;
  tooQuick: boolean;
}

const word = (n: number, kind: string) => `${n} ${kind}${n === 1 ? "" : "s"}`;

type RemovalPart = { total: number; refused: number; lost: number; tooQuick: boolean };

/** Clear board's outcome, once every note, frame and shape in it is accounted for (or the connection was lost). */
export function clearReportFor(notes: RemovalPart, frames: RemovalPart, shapes?: RemovalPart): DeleteReport {
  return removalReportFor("clear", notes, frames, shapes);
}

/** "a", "a and b", "a, b and c". */
const listed = (parts: readonly string[]) => (parts.length < 3 ? parts.join(" and ") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`);
const NO_PART: RemovalPart = { total: 0, refused: 0, lost: 0, tooQuick: false };

/** The outcome of a clear or of a delete of a selection with frames or shapes (only the all-done wording differs). */
export function removalReportFor(kind: "clear" | "delete", notes: RemovalPart, frames: RemovalPart, shapes: RemovalPart = NO_PART): DeleteReport {
  const kinds: [RemovalPart, string][] = [
    [notes, "note"],
    [frames, "frame"],
    [shapes, "shape"],
  ];
  const done = (p: RemovalPart) => p.total - p.refused - p.lost;
  if (kinds.every(([p]) => p.refused + p.lost === 0)) {
    const parts = kinds.flatMap(([p, name]) => (p.total > 0 ? [word(p.total, name)] : []));
    return { text: kind === "clear" ? `Cleared the board: deleted ${listed(parts)}.` : `Deleted ${listed(parts)}.`, partial: false };
  }
  const parts = [`Deleted ${listed(kinds.flatMap(([p, name]) => (p.total > 0 ? [`${done(p)} of ${word(p.total, name)}`] : [])))}.`];
  for (const [p, name] of kinds) {
    if (p.refused === 0) continue;
    const one = p.refused === 1;
    const why = p.tooQuick ? "that was too quick" : `the relay refused ${one ? "it" : "them"}`;
    parts.push(`${word(p.refused, name)} ${one ? "wasn’t" : "weren’t"} deleted because ${why}; ${one ? "it’s" : "they’re"} back on the board.`);
  }
  const lostKinds = kinds.filter(([p]) => p.lost > 0);
  const lost = lostKinds.reduce((sum, [p]) => sum + p.lost, 0);
  if (lost > 0) {
    const what = lostKinds.length === 1 ? lostKinds[0]![1] : "item";
    parts.push(`The connection was lost before ${word(lost, what)} ${lost === 1 ? "was" : "were"} deleted, so ${lost === 1 ? "it" : "they"} may still be on the board.`);
  }
  if (kinds.some(([p]) => p.refused > 0)) parts.push("Nothing was retried.");
  return { text: parts.join(" "), partial: true };
}

const randomRef = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_");
};

/** A selection with frames being dragged: every frame and note it moves, where each started. */
interface SelectionDrag {
  /** In selection order, each with the notes and shapes it carries. */
  frames: { id: string; start: NoteRect; noteIds: string[]; shapeIds: string[] }[];
  /** Every note moved (carried or loose) and its start. */
  notes: Map<string, NoteRect>;
  /** Every shape moved (carried or loose) and its start (protocol v15). */
  shapes: Map<string, NoteRect>;
  /** Selected notes no frame carries. */
  loose: string[];
  /** Selected shapes no frame carries. */
  looseShapes: string[];
  /** The next frame whose live move goes out (they take turns). */
  turn: number;
  /** Which loose batch (notes or shapes) goes out next when there are both. */
  batchTurn: number;
}

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
  /** A shape added here got its server id (protocol v15). */
  onShapeConfirmed?(localId: string, id: string): void;
  /** The browser's network and visibility (connection/reconnect.ts); always online and visible if not given. */
  env?: ConnectionEnv;
  /** GET /health, asked when sockets keep failing to open: is the relay there at all? */
  checkHealth?(): Promise<ProbeResult>;
  /** The name to rejoin with (stickyard:name); the name it joined with if none. */
  storedName?(): string | null;
  /** For the backoff's jitter (0..1). */
  random?(): number;
  /** Protocol v12: this room's host token on this device, if it started the session (sent only in claimHost). */
  hostToken?(): string | null;
  /** Protocol v12: forget the stored host token (refused, or the session ended or expired). */
  forgetHostToken?(): void;
  /** Protocol v13: this device's voter key for the room (made on first use; sent only in claimVoter). */
  voterKey?(): string | null;
  /** Protocol v13: forget the voter key (the session ended or expired). */
  forgetVoterKey?(): void;
  /** Protocol v14: where other people's pointers go (cursors/cursorStore.ts). Never part of the view. */
  cursors?: CursorSink;
}

/** Refusals of a voteSet that roll the vote back. */
const VOTE_REFUSALS = new Set(["over_budget", "voting_closed", "no_voter", "voters_full"]);
const sumVotes = (votes: ReadonlyMap<string, number>) => [...votes.values()].reduce((a, b) => a + b, 0);

/** Reconnecting: which try, why it waits, and its timer. */
interface Retry {
  phase: ReconnectPhase;
  /** The try waiting or running (1-based). */
  attempt: number;
  /** Sockets in a row that never opened. */
  failedOpens: number;
  /** Health probes while the relay looked down. */
  probes: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** A socket is open or opening for this try. */
  trying: boolean;
  /** A try (or a probe) is due but waits for the tab to be visible. */
  due: boolean;
  lastTryAt: number;
  /** Bumped by a new sequence: answers to older probes are ignored. */
  gen: number;
}

/** A frame being dragged here: where it and the notes it carries started. */
interface FrameDrag {
  id: string;
  start: NoteRect;
  /** Carried notes (confirmed ids only), by id, at their start. Empty: the frame moves alone. */
  notes: Map<string, NoteRect>;
  /** Carried shapes (protocol v15), likewise. */
  shapes: Map<string, NoteRect>;
}

/** A sent itemsAdd's list for one kind (to find a refused item's ref by its index). */
function itemList(message: ItemsAddMessage, kind: ItemKind): readonly { ref: string }[] | undefined {
  return kind === "note" ? message.notes : kind === "frame" ? message.frames : message.shapes;
}

export class RoomSession {
  private view: RoomView = INITIAL_VIEW;
  private socket: SocketLike | null = null;
  private opened = false;
  private welcomed = false;
  private stopped = false;
  /** Protocol v13: my votes as the relay last confirmed them, and dots left then. */
  private readonly votesConfirmed = new Map<string, number>();
  private votesLeft = VOTE_BUDGET_DEFAULT;
  /** Votes sent and not answered yet, per note, in send order. */
  private readonly votesPending = new Map<string, number[]>();
  /** The relay refused this visit as a voter (voters_full on claimVoter). */
  private votersFull = false;
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
  /** A selection with frames being dragged (startSelectionDrag). */
  private selectionDrag: SelectionDrag | null = null;
  /** frameEdits for several frames (editFrames), sent one every CLEAR_FRAME_STEP_MS. */
  private frameEditQueue: ClientMessage[] = [];
  private frameEditTimer: ReturnType<typeof setTimeout> | undefined;
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
  /** Clear board in flight, and its frame-delete pacing timer. */
  private clearRun: ClearRun | null = null;
  private clearTimer: ReturnType<typeof setTimeout> | undefined;
  /** Refreshes undo and redo when a change waiting for the relay is given up on. */
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;
  private expiryAt: number | null = null;
  /** Reconnecting after a drop (null while joined or before the first join). */
  private retry: Retry | null = null;
  private retryGen = 0;
  /** A reconnect got `joined`: the snapshot makes it live. Then frames replace the old ones. */
  private resyncing = false;
  private framesResync = false;
  private shapesResync = false;
  /** Shapes' live moves and resizes (throttled like notes'), and adds deleted here before confirmed. */
  private readonly shapeMoves = new Map<string, Throttle>();
  private readonly shapeResizes = new Map<string, Throttle>();
  private readonly abandonedShapes = new Set<string>();
  /** Each socket's events carry its number; a replaced socket's late events are ignored. */
  private socketGen = 0;
  private joinedName: string | null = null;
  private readonly yourIds = new Set<string>();
  private readonly env: ConnectionEnv;
  private unlisten: (() => void) | null = null;
  /** When the tab was hidden (null while visible). */
  private hiddenSince: number | null = null;
  /** Join/leave events waiting for the next toast, its timer, and the toast's hide timer. */
  private presenceEvents: PresenceEvent[] = [];
  private presenceTimer: ReturnType<typeof setTimeout> | undefined;
  private presenceDue = 0;
  private batchStart = 0;
  /** Names whose leave was shown, and when: back soon after isn't news. */
  private readonly recentlyLeft = new Map<string, number>();
  private toastTimer: ReturnType<typeof setTimeout> | undefined;
  private lastToastAt = -Infinity;
  private toastSeq = 0;
  /** After my own reconnect: names that were here before the drop, quiet until `quietUntil`. */
  private quietNames = new Set<string>();
  private quietUntil = 0;
  /** Protocol v14: the others were sent my pointer and not told it left (cursorLeft is owed). */
  private cursorShown = false;

  constructor(private readonly options: SessionOptions) {
    this.env = options.env ?? STATIC_ENV;
  }

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
    this.listen();
    if (!this.openSocket()) this.finish("unreachable");
  }

  /** Opens a socket (its events tagged, so a replaced socket's late ones are ignored). False if it couldn't be made. */
  private openSocket(): boolean {
    const gen = ++this.socketGen;
    this.opened = false;
    this.welcomed = false;
    const mine = <A extends unknown[]>(fn: (...args: A) => void) => (...args: A) => {
      if (gen === this.socketGen) fn(...args);
    };
    try {
      this.socket = this.options.createSocket(this.options.url, {
        onOpen: mine(() => this.onOpen()),
        onMessage: mine((data: unknown) => this.onMessage(data)),
        onClose: mine((code?: number) => this.onClose(code)),
        onError: () => {
          // A close event always follows.
        },
      });
      return true;
    } catch {
      this.socket = null;
      return false;
    }
  }

  /** Lets go of the socket (closing it); its later events are ignored. */
  private detach(close: boolean): void {
    this.socketGen++;
    if (close) {
      try {
        this.socket?.close();
      } catch {
        // Already closed.
      }
    }
    this.socket = null;
    this.opened = false;
    this.welcomed = false;
  }

  /* ── Reconnect (connection/reconnect.ts) ───────────────────────── */

  /** Starts following the browser's network and visibility (once). */
  private listen(): void {
    if (this.unlisten) return;
    this.hiddenSince = this.env.hidden() ? Date.now() : null;
    this.unlisten = this.env.listen({
      online: () => this.onOnline(),
      offline: () => this.onOffline(),
      visibility: () => this.onVisibility(),
    });
  }

  /** Rejoin: tries again now, with the backoff from the start (after a drop only). */
  rejoin(): void {
    if (this.stopped || !this.retry) return;
    this.restartRetry();
    this.tryNow();
  }

  /** What the page shows about reconnecting. */
  private retryView(): ReconnectView | null {
    const r = this.retry;
    return r ? { phase: r.phase, attempt: r.attempt, max: RECONNECT_MAX_ATTEMPTS } : null;
  }

  private restartRetry(): void {
    const r = this.retry;
    if (!r) return;
    clearTimeout(r.timer);
    if (r.trying) this.detach(true);
    clearTimeout(this.timer);
    Object.assign(r, { phase: "reconnecting", attempt: 1, failedOpens: 0, probes: 0, timer: undefined, trying: false, due: false, gen: ++this.retryGen });
    this.resyncing = false;
  }

  private stopRetry(): void {
    if (!this.retry) return;
    clearTimeout(this.retry.timer);
    this.retry = null;
    this.retryGen++;
  }

  /** The name to rejoin with: the stored one, else the one it joined with. */
  private rejoinName(): string | null {
    return cleanName(this.options.storedName?.() ?? "") ?? this.joinedName ?? this.pendingName;
  }

  /** Opens a socket for the current try. */
  private tryNow(): void {
    const r = this.retry;
    if (!r || this.stopped) return;
    clearTimeout(r.timer);
    r.timer = undefined;
    r.due = false;
    if (!this.env.online()) {
      r.phase = "network";
      return this.update({});
    }
    r.phase = "reconnecting";
    r.trying = true;
    r.lastTryAt = Date.now();
    this.resyncing = false;
    this.pendingName = this.rejoinName();
    this.startTimer();
    if (!this.openSocket()) return this.tryFailed(false);
    this.update({});
  }

  /** The try's socket closed, timed out or never opened. */
  private tryFailed(opened: boolean): void {
    const r = this.retry;
    if (!r) return;
    clearTimeout(this.timer);
    this.detach(true);
    r.trying = false;
    this.resyncing = false;
    r.failedOpens = opened ? 0 : r.failedOpens + 1;
    if (!opened && shouldProbe(r.failedOpens)) return this.probe();
    this.nextTry();
  }

  /** Schedules the next try with backoff, or gives up (Rejoin). */
  private nextTry(): void {
    const r = this.retry;
    if (!r) return;
    if (afterFailedTry(r.attempt) === "give-up") {
      r.phase = "offline";
      return this.update({});
    }
    r.attempt++;
    r.phase = "reconnecting";
    this.schedule(backoffDelay(r.attempt, this.options.random ?? Math.random));
  }

  private schedule(ms: number): void {
    const r = this.retry;
    if (!r) return;
    clearTimeout(r.timer);
    r.timer = setTimeout(() => {
      r.timer = undefined;
      this.due();
    }, ms);
    this.update({});
  }

  /** A try (or a probe) is due: run it, unless the browser is offline or the tab has been hidden for long. */
  private due(): void {
    const r = this.retry;
    if (!r || this.stopped) return;
    if (!this.env.online()) {
      r.phase = "network";
      return this.update({});
    }
    if (r.phase === "limit") {
      if (this.env.hidden()) {
        r.due = true;
        return;
      }
      return this.limitProbe();
    }
    if (!mayTryWhileHidden(this.hiddenSince, Date.now())) {
      r.due = true;
      return;
    }
    this.tryNow();
  }

  /** Sockets keep failing to open: is the relay there (and is the link valid)? */
  private probe(): void {
    const r = this.retry;
    const check = this.options.checkHealth;
    if (!r || !check) return this.nextTry();
    const gen = r.gen;
    const stale = () => this.stopped || this.retry !== r || r.gen !== gen;
    void check()
      .catch((): ProbeResult => "down")
      .then(async (result) => {
        if (stale()) return;
        if (result === "reload") return this.finish("reload");
        if (result === "down") return this.enterLimit();
        const code = await this.options.checkCode().catch((): CodeCheck => "unreachable");
        if (stale()) return;
        if (code === "invalid") return this.finish("invalid");
        this.nextTry();
      });
  }

  /** The relay looks down or over its daily limit: one probe a minute (while visible), no sockets. */
  private enterLimit(): void {
    const r = this.retry;
    if (!r) return;
    r.phase = "limit";
    r.probes = 1;
    this.schedule(LIMIT_RETRY_MS);
  }

  private limitProbe(): void {
    const r = this.retry;
    const check = this.options.checkHealth;
    if (!r || !check) return;
    r.probes++;
    const gen = r.gen;
    void check()
      .catch((): ProbeResult => "down")
      .then((result) => {
        if (this.stopped || this.retry !== r || r.gen !== gen || r.phase !== "limit") return;
        if (result === "reload") return this.finish("reload");
        if (result === "ok") {
          Object.assign(r, { attempt: 1, failedOpens: 0, probes: 0 });
          return this.tryNow();
        }
        if (r.probes >= LIMIT_MAX_PROBES) {
          r.phase = "offline";
          return this.update({});
        }
        this.schedule(LIMIT_RETRY_MS);
      });
  }

  /** The browser is back online: a fresh sequence, now (not for a full session: that needs Rejoin). */
  private onOnline(): void {
    const r = this.retry;
    if (this.stopped || !r || r.trying || r.phase === "full") return;
    if (Date.now() - r.lastTryAt < MIN_TRY_GAP_MS) return;
    this.restartRetry();
    this.tryNow();
  }

  /** The browser went offline: drop at once (no waiting for the socket to notice), then wait for online. */
  private onOffline(): void {
    if (this.stopped) return;
    if (this.view.status === "joined") {
      this.detach(true);
      return this.dropped();
    }
    const r = this.retry;
    if (!r || r.phase === "full") return;
    clearTimeout(r.timer);
    r.timer = undefined;
    if (r.trying) {
      clearTimeout(this.timer);
      this.detach(true);
      r.trying = false;
      this.resyncing = false;
    }
    r.phase = "network";
    this.update({});
  }

  /** Visible again: what was due runs now; a waiting try doesn't wait any longer. */
  private onVisibility(): void {
    if (this.stopped) return;
    if (this.env.hidden()) {
      this.hiddenSince ??= Date.now();
      // A hidden tab shares no pointer.
      this.hideCursor();
      return;
    }
    this.hiddenSince = null;
    const r = this.retry;
    if (!r || r.trying) return;
    if (r.phase === "limit") {
      if (r.due) {
        r.due = false;
        this.limitProbe();
      }
      return;
    }
    if (r.phase !== "reconnecting") return;
    if (Date.now() - r.lastTryAt < MIN_TRY_GAP_MS) return;
    this.tryNow();
  }

  /** The connection dropped while joined: settle what was in flight, go back to what's confirmed, start reconnecting. */
  private dropped(): void {
    clearTimeout(this.timer);
    this.stopAllMoves();
    this.socket = null;
    this.forgetCursors();
    // Joins and leaves not shown yet are forgotten; people here now aren't news when they come back.
    clearTimeout(this.presenceTimer);
    this.presenceTimer = undefined;
    this.presenceEvents = [];
    this.quietNames = new Set(this.view.participants.filter((p) => !this.yourIds.has(p.id)).map((p) => p.name));
    // What was in flight, counted before anything is cleared. Runs report their own losses.
    const excluded = new Set<string>();
    const both = (id: string) => {
      excluded.add(`note:${id}`);
      excluded.add(`frame:${id}`);
      excluded.add(`shape:${id}`);
    };
    for (const run of [this.template?.run, this.restoreRun]) for (const ref of run?.refs ?? []) if (ref !== null) both(localId(ref));
    const run = this.deleteRun;
    for (const id of run?.ids ?? []) excluded.add(`note:${id}`);
    for (const ref of run?.refs ?? []) excluded.add(`note:${localId(ref)}`);
    const clear = this.clearRun;
    for (const id of clear?.notes.ids ?? []) excluded.add(`note:${id}`);
    for (const ref of clear?.notes.refs ?? []) excluded.add(`note:${localId(ref)}`);
    for (const id of clear?.frames.ids ?? []) excluded.add(`frame:${id}`);
    for (const ref of clear?.frames.refs ?? []) excluded.add(`frame:${localId(ref)}`);
    for (const id of clear?.shapes.ids ?? []) excluded.add(`shape:${id}`);
    for (const ref of clear?.shapes.refs ?? []) excluded.add(`shape:${localId(ref)}`);
    const unsaved = unsavedKeys(this.view.board, this.history.pendingKeys(), excluded).size;

    this.deleteRun = null;
    const lost = run ? run.ids.size + run.refs.size : 0;
    // Nothing queued is sent later: there's no offline queue.
    clearTimeout(this.itemTimer);
    this.itemTimer = undefined;
    this.itemQueue = [];
    this.itemBatches.clear();
    const restore = this.restoreRun;
    this.restoreRun = null;
    this.clearRun = null;
    clearTimeout(this.clearTimer);
    this.clearTimer = undefined;
    this.abandoned.clear();
    this.abandonedFrames.clear();
    this.abandonedShapes.clear();
    // Ids and revs can't be trusted after this: the history goes.
    this.history.clear();
    const { board, orphans } = discardUnconfirmed(this.view.board);
    this.retry = { phase: this.env.online() ? "reconnecting" : "network", attempt: 1, failedOpens: 0, probes: 0, timer: undefined, trying: false, due: false, lastTryAt: -Infinity, gen: ++this.retryGen };
    // Votes still waiting go too: the next claim's voterGranted says what the relay has.
    this.votesPending.clear();
    this.votersFull = false;
    this.update({
      status: "disconnected",
      lockPending: null,
      isVoter: false,
      votersFull: false,
      ...this.voteView(),
      board,
      dropReport: unsaved > 0 ? DROP_TEXT.unsaved(unsaved) : null,
      ...(orphans.length > 0 ? { orphanDraft: orphans.at(-1) ?? null } : {}),
      ...(run ? { deleteReport: deleteReportFor({ ...run, lost }) } : {}),
      ...(clear
        ? {
            deleteReport: removalReportFor(
              clear.kind,
              { ...clear.notes, lost: clear.notes.ids.size + clear.notes.refs.size },
              { ...clear.frames, lost: clear.frames.ids.size + clear.frames.refs.size + clear.frames.queue.length },
              { ...clear.shapes, lost: clear.shapes.ids.size + clear.shapes.refs.size },
            ),
          }
        : {}),
      ...(restore ? { historyReport: { text: UNDO_TEXT.restoreLost(restoredCount(restore), restore.refs.length), partial: true } } : {}),
      // A template cut off part-way: what was made stays, and the notice says so.
      ...this.templateEnd("partial"),
    });
    if (this.retry.phase === "reconnecting") this.schedule(backoffDelay(1, this.options.random ?? Math.random));
  }

  /* ── Presence toasts (presence/toasts.ts) ───────────────────────── */

  /** A join or leave: shown in the next toast, after the batch window and at least the gap after the last one. */
  private presence(event: PresenceEvent): void {
    const now = Date.now();
    if (this.presenceEvents.length === 0) this.batchStart = now;
    this.presenceEvents.push(event);
    // After the batch window, a leave's grace (a quick reconnect cancels it) and the gap after the last toast.
    const due = Math.max(this.batchStart + TOAST_BATCH_MS, event.kind === "left" ? now + LEAVE_GRACE_MS : 0, this.lastToastAt + TOAST_GAP_MS);
    if (this.presenceTimer !== undefined && due <= this.presenceDue) return;
    clearTimeout(this.presenceTimer);
    this.presenceDue = due;
    this.presenceTimer = setTimeout(() => {
      this.presenceTimer = undefined;
      this.showToast();
    }, due - now);
  }

  private showToast(): void {
    const events = this.presenceEvents;
    const text = summarizePresence(events);
    this.presenceEvents = [];
    for (const e of events) if (e.kind === "left") this.recentlyLeft.set(e.name, Date.now());
    if (this.stopped || text === null) return;
    const seq = ++this.toastSeq;
    this.lastToastAt = Date.now();
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      if (this.view.presenceToast?.seq === seq) this.update({ presenceToast: null });
    }, TOAST_SHOW_MS);
    this.update({ presenceToast: { seq, text } });
  }

  /** Adds the orphaned draft back as a new note where its note was. Its local id, or null. */
  restoreDraft(): string | null {
    const draft = this.view.orphanDraft;
    if (!draft || !this.live) return null;
    const id = this.addNote({ x: draft.x, y: draft.y, color: draft.color, text: draft.text });
    if (id) this.update({ orphanDraft: null });
    return id;
  }

  /** Forgets the orphaned draft. */
  dismissDraft(): void {
    if (this.stopped || !this.view.orphanDraft) return;
    this.update({ orphanDraft: null });
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
   * Arrange (align, distribute, match size, grid): new rects for several notes and shapes (v15),
   * shown at once and sent as final batches (noteBatch, shapeBatch), one history step.
   * Position-only changes go as moves, size changes as resizes. False if refused.
   */
  applyRects(rects: readonly (NoteRect & { id: string })[]): boolean {
    if (!this.live) return false;
    let board = this.view.board;
    const ops: NoteBatchEntry[] = [];
    // Shapes arranged with notes (protocol v15): their rects go out as one shapeBatch.
    const shapeOps: ShapeBatchEntry[] = [];
    for (const rect of rects) {
      if (isLocalId(rect.id)) continue;
      const shape = findShape(board, rect.id)?.shape;
      if (shape) {
        board = resizeShapeLocal(board, rect.id, rect);
        const after = findShape(board, rect.id)?.shape;
        if (!after || after === shape) continue;
        const { id, x, y, w, h } = after;
        shapeOps.push(w === shape.w && h === shape.h ? { op: "move", id, x, y } : { op: "resize", id, x, y, w, h });
        continue;
      }
      const before = findNote(board, rect.id)?.note;
      if (!before) continue;
      board = resizeLocal(board, rect.id, rect);
      const after = findNote(board, rect.id)?.note;
      if (!after || after === before) continue;
      const { id, x, y, w, h } = after;
      ops.push(w === before.w && h === before.h ? { op: "move", id, x, y } : { op: "resize", id, x, y, w, h });
    }
    if (ops.length + shapeOps.length === 0) return true;
    this.update({ board, noteNotice: null });
    this.recordRects(
      "Arrange",
      [...ops.map(() => "note" as const), ...shapeOps.map(() => "shape" as const)],
      [...ops.map((o) => o.id), ...shapeOps.map((o) => o.id)],
      ["x", "y", "w", "h"],
    );
    this.sendBatch(ops, true);
    this.sendShapeBatch(shapeOps, true);
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
    this.clearRun?.notes.ids.delete(id);
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
    // Notes and shapes share the stacking space (v15).
    const notes = ids.flatMap((id) => (isLocalId(id) ? [] : (findNote(this.view.board, id)?.note ?? findShape(this.view.board, id)?.shape ?? [])));
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
    const insideShapes = carry ? framedNotes(entry.frame, this.view.board.shapes.map((x) => x.shape)).filter((x) => !isLocalId(x.id)) : [];
    // The carry cap is shared by notes and shapes (protocol v15).
    const tooMany = inside.length + insideShapes.length > MAX_BATCH_ENTRIES;
    const notes = new Map(tooMany ? [] : inside.map((n) => [n.id, { x: n.x, y: n.y, w: n.w, h: n.h }] as const));
    const shapes = new Map(tooMany ? [] : insideShapes.map((n) => [n.id, { x: n.x, y: n.y, w: n.w, h: n.h }] as const));
    let board = setFrameDragging(this.view.board, id, true);
    for (const noteId of notes.keys()) board = setDragging(board, noteId, true);
    for (const shapeId of shapes.keys()) board = setShapeDragging(board, shapeId, true);
    const { x, y, w, h } = entry.frame;
    this.frameDrag = { id, start: { x, y, w, h }, notes, shapes };
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
    const drag =
      this.frameDrag?.id === id
        ? this.frameDrag
        : { id, start: { x: entry.frame.x, y: entry.frame.y, w: entry.frame.w, h: entry.frame.h }, notes: new Map<string, NoteRect>(), shapes: new Map<string, NoteRect>() };
    const target = clampFramePosition(x, y, drag.start);
    const want = { dx: target.x - drag.start.x, dy: target.y - drag.start.y };
    const { dx, dy } = drag.notes.size + drag.shapes.size > 0 ? groupOffset([drag.start, ...drag.notes.values(), ...drag.shapes.values()], want.dx, want.dy) : want;
    let board = moveFrameLocal(this.view.board, id, drag.start.x + dx, drag.start.y + dy);
    for (const [noteId, r] of drag.notes) board = moveLocal(board, noteId, r.x + dx, r.y + dy);
    for (const [shapeId, r] of drag.shapes) board = moveShapeLocal(board, shapeId, r.x + dx, r.y + dy);
    const noteIds = [...drag.notes.keys()].filter((n) => findNote(board, n));
    const shapeIds = [...drag.shapes.keys()].filter((n) => findShape(board, n));
    if (final) {
      board = setFrameDragging(board, id, false);
      for (const n of drag.notes.keys()) board = setDragging(board, n, false);
      for (const n of drag.shapes.keys()) board = setShapeDragging(board, n, false);
      this.frameDrag = null;
    }
    this.update({ board });
    if (final) {
      this.stopFrameMove(id);
      this.recordRects(
        "Move frame",
        ["frame", ...noteIds.map(() => "note" as const), ...shapeIds.map(() => "shape" as const)],
        [id, ...noteIds, ...shapeIds],
        ["x", "y"],
      );
      return this.sendFrameMove(id, noteIds, true, shapeIds);
    }
    this.throttle(this.frameMoves, id, MOVE_INTERVAL_MS, () => this.sendFrameMove(id, noteIds, false, shapeIds));
  }

  /**
   * Starts dragging a selection with frames (v0.20.0; md and up): each frame carries the notes
   * whose centre is inside it, unless `carry` is false (Alt held), each note once (the first
   * selected frame that holds it), and the selected notes no frame carries come too. A frame
   * holding more than MAX_BATCH_ENTRIES notes moves alone (the frame-drag notice says so). Only
   * confirmed items that aren't already moving. False if nothing can move, not connected, or a
   * guest on a locked board.
   */
  startSelectionDrag(frameIds: readonly string[], noteIds: readonly string[], carry: boolean, shapeIds: readonly string[] = []): boolean {
    if (!this.live || lockedOut(this.view)) return false;
    const board0 = this.view.board;
    const frames = frameIds.flatMap((id) => {
      const entry = findFrame(board0, id);
      return entry && !isLocalId(id) && !isFrameHeld(entry) ? [entry.frame] : [];
    });
    const movable = board0.notes.filter((n) => !isLocalId(n.note.id) && !isHeld(n)).map((n) => n.note);
    const movableShapes = board0.shapes.filter((x) => !isLocalId(x.shape.id) && !isShapeHeld(x)).map((x) => x.shape);
    const plan = carryPlan(frames, movable, noteIds, carry, MAX_BATCH_ENTRIES, movableShapes, shapeIds);
    if (plan.frames.length + plan.loose.length + plan.looseShapes.length === 0) return false;
    const rectOf = (r: NoteRect): NoteRect => ({ x: r.x, y: r.y, w: r.w, h: r.h });
    const notes = new Map<string, NoteRect>();
    for (const id of [...plan.frames.flatMap((f) => f.noteIds), ...plan.loose]) {
      const note = findNote(board0, id)?.note;
      if (note) notes.set(id, rectOf(note));
    }
    const shapes = new Map<string, NoteRect>();
    for (const id of [...plan.frames.flatMap((f) => f.shapeIds), ...plan.looseShapes]) {
      const shape = findShape(board0, id)?.shape;
      if (shape) shapes.set(id, rectOf(shape));
    }
    let board = board0;
    for (const f of frames) board = setFrameDragging(board, f.id, true);
    for (const id of notes.keys()) board = setDragging(board, id, true);
    for (const id of shapes.keys()) board = setShapeDragging(board, id, true);
    this.selectionDrag = {
      frames: plan.frames.map((p) => ({ id: p.id, start: rectOf(findFrame(board0, p.id)!.frame), noteIds: p.noteIds, shapeIds: p.shapeIds })),
      notes,
      shapes,
      loose: plan.loose,
      looseShapes: plan.looseShapes,
      turn: 0,
      batchTurn: 0,
    };
    this.update({ board, noteNotice: plan.alone.length > 0 ? NOTICES.frameTooFull : null });
    return true;
  }

  /**
   * Moves the dragged selection by (dx, dy) from where it started, clamped once for the whole
   * group (groupOffset), so its arrangement is kept at the board's edges. Shown here at once; live
   * updates are throttled (SELECTION_MOVE_INTERVAL_MS, SELECTION_LIVE_MESSAGES). The final move
   * sends one frameMove per frame (with the notes it carries) and the loose notes as final
   * batches, and is one undo step. Returns the delta applied.
   */
  moveSelection(dx: number, dy: number, final: boolean): { dx: number; dy: number } {
    const drag = this.selectionDrag;
    if (!this.live || !drag) return { dx: 0, dy: 0 };
    const offset = groupOffset([...drag.frames.map((f) => f.start), ...drag.notes.values(), ...drag.shapes.values()], dx, dy);
    let board = this.view.board;
    for (const f of drag.frames) board = moveFrameLocal(board, f.id, f.start.x + offset.dx, f.start.y + offset.dy);
    for (const [id, r] of drag.notes) board = moveLocal(board, id, r.x + offset.dx, r.y + offset.dy);
    for (const [id, r] of drag.shapes) board = moveShapeLocal(board, id, r.x + offset.dx, r.y + offset.dy);
    if (!final) {
      this.update({ board });
      this.throttle(this.groupMoves, "selection", SELECTION_MOVE_INTERVAL_MS, () => this.sendSelectionTick());
      return offset;
    }
    for (const f of drag.frames) board = setFrameDragging(board, f.id, false);
    for (const id of drag.notes.keys()) board = setDragging(board, id, false);
    for (const id of drag.shapes.keys()) board = setShapeDragging(board, id, false);
    this.stopSelectionDrag();
    this.update({ board });
    const frames = drag.frames.filter((f) => findFrame(board, f.id));
    const notes = [...drag.notes.keys()].filter((id) => findNote(board, id));
    const shapes = [...drag.shapes.keys()].filter((id) => findShape(board, id));
    const ids = [...frames.map((f) => f.id), ...notes, ...shapes];
    this.recordRects(
      "Move",
      [...frames.map(() => "frame" as const), ...notes.map(() => "note" as const), ...shapes.map(() => "shape" as const)],
      ids,
      ["x", "y"],
      `move:${[...ids].sort().join(",")}`,
    );
    for (const f of frames) this.sendFrameMove(f.id, f.noteIds.filter((id) => findNote(board, id)), true, f.shapeIds.filter((id) => findShape(board, id)));
    this.sendBatch(this.moveEntries(drag.loose), true);
    this.sendShapeBatch(this.shapeMoveEntries(drag.looseShapes), true);
    return offset;
  }

  /** One live update of a selection drag: the loose notes' batch, then frames taking turns, at most SELECTION_LIVE_MESSAGES. */
  private sendSelectionTick(): void {
    const drag = this.selectionDrag;
    if (!drag || !this.live) return;
    let budget = SELECTION_LIVE_MESSAGES;
    // At most one live batch a tick (notes and shapes take turns when there are both), so the
    // entries stay at most 50 a tick (500 a second) inside BATCH_LIMITS.
    const batches = [
      ...(drag.loose.length > 0 ? [() => this.sendBatch(this.moveEntries(drag.loose.slice(0, MAX_BATCH_ENTRIES)), false)] : []),
      ...(drag.looseShapes.length > 0 ? [() => this.sendShapeBatch(this.shapeMoveEntries(drag.looseShapes.slice(0, MAX_BATCH_ENTRIES)), false)] : []),
    ];
    if (batches.length > 0) {
      batches[drag.batchTurn++ % batches.length]!();
      budget--;
    }
    const count = Math.min(budget, drag.frames.length);
    for (let i = 0; i < count; i++) {
      const f = drag.frames[drag.turn++ % drag.frames.length]!;
      this.sendFrameMove(f.id, f.noteIds.filter((id) => findNote(this.view.board, id)), false, f.shapeIds.filter((id) => findShape(this.view.board, id)));
    }
  }

  private shapeMoveEntries(ids: readonly string[]): ShapeBatchEntry[] {
    return ids.flatMap((id) => {
      const shape = findShape(this.view.board, id)?.shape;
      return shape ? [{ op: "move" as const, id, x: shape.x, y: shape.y }] : [];
    });
  }

  private stopSelectionDrag(): void {
    clearTimeout(this.groupMoves.get("selection")?.timer);
    this.groupMoves.delete("selection");
    this.selectionDrag = null;
  }

  /**
   * Arrange on frames (v0.20.0): new rects for several frames, shown at once and sent final, one
   * history step. A frame whose position changes carries the notes whose centre is inside it (one
   * frameMove with noteIds; each note once, to the first frame; more than MAX_BATCH_ENTRIES: the
   * frame moves alone, with the notice), by one delta clamped for the frame and its notes, as the
   * relay does. A frame whose size changes (Match size) is resized alone (frameResize). False if
   * refused (not connected, or a guest on a locked board).
   */
  applyFrameRects(rects: readonly (NoteRect & { id: string })[]): boolean {
    if (!this.live || lockedOut(this.view)) return false;
    const board0 = this.view.board;
    const usable = rects.flatMap((r) => {
      const entry = findFrame(board0, r.id);
      return entry && !isLocalId(r.id) && !isFrameHeld(entry) ? [{ rect: r, frame: entry.frame }] : [];
    });
    const moving = usable.filter(({ rect, frame }) => rect.w === frame.w && rect.h === frame.h);
    const movable = board0.notes.filter((n) => !isLocalId(n.note.id) && !isHeld(n)).map((n) => n.note);
    const movableShapes = board0.shapes.filter((x) => !isLocalId(x.shape.id) && !isShapeHeld(x)).map((x) => x.shape);
    const plan = carryPlan(moving.map((m) => m.frame), movable, [], true, MAX_BATCH_ENTRIES, movableShapes, []);
    const carried = new Map(plan.frames.map((p) => [p.id, p.noteIds]));
    const carriedShapes = new Map(plan.frames.map((p) => [p.id, p.shapeIds]));
    let board = board0;
    const sends: ClientMessage[] = [];
    const kinds: ItemKind[] = [];
    const ids: string[] = [];
    for (const { rect, frame } of usable) {
      const noteIds = carried.get(frame.id);
      if (noteIds === undefined) {
        board = resizeFrameLocal(board, frame.id, rect);
        const f = findFrame(board, frame.id)?.frame ?? frame;
        if (f === frame) continue;
        sends.push({ type: "frameResize", id: f.id, x: f.x, y: f.y, w: f.w, h: f.h, final: true });
        kinds.push("frame");
        ids.push(f.id);
        continue;
      }
      const notes = noteIds.flatMap((id) => findNote(board, id)?.note ?? []);
      const shapes = (carriedShapes.get(frame.id) ?? []).flatMap((id) => findShape(board, id)?.shape ?? []);
      const target = clampFramePosition(rect.x, rect.y, frame);
      const { dx, dy } = groupOffset([frame, ...notes, ...shapes], target.x - frame.x, target.y - frame.y);
      if (dx === 0 && dy === 0) continue;
      board = moveFrameLocal(board, frame.id, frame.x + dx, frame.y + dy);
      for (const n of notes) board = moveLocal(board, n.id, n.x + dx, n.y + dy);
      for (const x of shapes) board = moveShapeLocal(board, x.id, x.x + dx, x.y + dy);
      sends.push({
        type: "frameMove",
        id: frame.id,
        x: frame.x + dx,
        y: frame.y + dy,
        final: true,
        ...(notes.length > 0 ? { noteIds: notes.map((n) => n.id) } : {}),
        ...(shapes.length > 0 ? { shapeIds: shapes.map((x) => x.id) } : {}),
      });
      kinds.push("frame", ...notes.map(() => "note" as const), ...shapes.map(() => "shape" as const));
      ids.push(frame.id, ...notes.map((n) => n.id), ...shapes.map((x) => x.id));
    }
    if (sends.length === 0) return true;
    this.update({ board, noteNotice: plan.alone.length > 0 ? NOTICES.frameTooFull : null });
    this.recordRects("Arrange", kinds, ids, ["x", "y", "w", "h"]);
    for (const message of sends) this.send(message);
    return true;
  }

  /**
   * Colour and title style for several frames at once (v0.20.0, Properties): shown at once, then
   * one frameEdit per frame with only what changes for it, sent one every CLEAR_FRAME_STEP_MS (so
   * 30 frames stay inside SOCKET_LIMITS), one history step. Titles aren't edited here. Confirmed
   * frames only. False if refused (not connected, or a guest on a locked board).
   */
  editFrames(ids: readonly string[], change: FrameEdit): boolean {
    if (!this.live || lockedOut(this.view)) return false;
    const { title: _, ...style } = change;
    let board = this.view.board;
    const edits: { id: string; edit: FrameEdit }[] = [];
    for (const id of ids) {
      const entry = findFrame(board, id);
      if (!entry || isLocalId(id)) continue;
      const before = entry.frame;
      board = editFrameLocal(board, id, style);
      const edit = frameChanges(before, findFrame(board, id)?.frame ?? before);
      if (Object.keys(edit).length > 0) edits.push({ id, edit });
    }
    if (edits.length === 0) return true;
    this.update({ board, noteNotice: null });
    this.record(
      "Edit frames",
      edits.map((e) => ({ kind: "frame" as const, id: e.id, after: e.edit as Fields })),
    );
    for (const { id, edit } of edits) this.frameEditQueue.push({ type: "frameEdit", id, ...edit });
    this.pumpFrameEdits();
    return true;
  }

  /**
   * Text style, fill and border for several shapes at once (protocol v15, Properties): shown at
   * once, then one shapeEdit per shape with only what changes for it, paced like editFrames (one
   * every CLEAR_FRAME_STEP_MS), one history step. Text isn't edited here. Confirmed shapes only.
   * False if refused (not connected, or a guest on a locked board).
   */
  editShapes(ids: readonly string[], change: ShapeEdit): boolean {
    if (!this.live || lockedOut(this.view)) return false;
    const { text: _, ...style } = change;
    let board = this.view.board;
    const edits: { id: string; edit: ShapeEdit }[] = [];
    for (const id of ids) {
      const entry = findShape(board, id);
      if (!entry || isLocalId(id)) continue;
      const before = entry.shape;
      board = editShapeLocal(board, id, style);
      const edit = shapeChanges(before, findShape(board, id)?.shape ?? before);
      if (Object.keys(edit).length > 0) edits.push({ id, edit });
    }
    if (edits.length === 0) return true;
    this.update({ board, noteNotice: null });
    this.record(
      "Edit shapes",
      edits.map((e) => ({ kind: "shape" as const, id: e.id, after: e.edit as Fields })),
    );
    // The same paced queue as frame edits (it holds any edit message).
    for (const { id, edit } of edits) this.frameEditQueue.push({ type: "shapeEdit", id, ...edit });
    this.pumpFrameEdits();
    return true;
  }

  /** Sends the next queued frameEdit or shapeEdit, then waits CLEAR_FRAME_STEP_MS. */
  private pumpFrameEdits(): void {
    if (this.frameEditTimer !== undefined || !this.live) return;
    const message = this.frameEditQueue.shift();
    if (!message) return;
    this.send(message);
    this.frameEditTimer = setTimeout(() => {
      this.frameEditTimer = undefined;
      this.pumpFrameEdits();
    }, CLEAR_FRAME_STEP_MS);
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

  /* ── Shapes (protocol v15) ────────────────────────────────────────── */

  /**
   * Adds a shape of a kind (its default size and style, no text), shown at once on top. Its
   * temporary id, or null if not connected or the board has its shapes already.
   */
  addShape({ kind, x, y }: { kind: ShapeKind; x: number; y: number }): string | null {
    if (!this.live || !this.view.you) return null;
    if (this.view.board.shapes.length >= MAX_SHAPES_PER_ROOM) {
      this.update({ noteNotice: NOTICES.shapesFull });
      return null;
    }
    const clientRef = randomRef();
    const board = addShapeLocal(this.view.board, { clientRef, kind, x, y, authorId: this.view.you.id });
    const shape = findShape(board, localId(clientRef))?.shape;
    if (!shape) return null;
    this.update({ board, noteNotice: null });
    this.history.recordAdd("Add shape", [{ kind: "shape", id: shape.id }], Date.now());
    this.send({ type: "shapeAdd", clientRef, kind, x: shape.x, y: shape.y });
    return shape.id;
  }

  /**
   * Text (cleaned like note text) and/or style, shown at once; only the fields that changed are
   * sent, as one shapeEdit. A shape not confirmed yet sends them once it is. An unchanged text just
   * ends the draft. False if refused.
   */
  editShape(id: string, change: ShapeEdit): boolean {
    if (!this.live) return false;
    const entry = findShape(this.view.board, id);
    const text = change.text === undefined ? undefined : cleanShapeText(change.text);
    if (!entry || text === null) return false;
    const before = entry.shape;
    const board = editShapeLocal(this.view.board, id, { ...change, ...(text !== undefined ? { text } : {}) });
    const after = findShape(board, id)?.shape ?? before;
    this.update({ board, noteNotice: null });
    if (isLocalId(id)) return true;
    const edit = shapeChanges(before, after);
    if (Object.keys(edit).length > 0) {
      this.record(edit.text !== undefined ? "Edit text" : "Style", [{ kind: "shape", id, after: edit as Fields }]);
      this.send({ type: "shapeEdit", id, ...edit });
    }
    return true;
  }

  /** Text being typed into a shape; kept even if someone else edits it meanwhile. */
  setShapeDraft(id: string, draft: string | null): void {
    if (this.stopped) return;
    this.update({ board: setShapeDraft(this.view.board, id, draft) });
  }

  /** Starts dragging a shape. False if it can't move now (not connected, or not confirmed). */
  startShapeDrag(id: string): boolean {
    if (!this.live || isLocalId(id) || !findShape(this.view.board, id)) return false;
    this.update({ board: setShapeDragging(this.view.board, id, true), noteNotice: null });
    return true;
  }

  /** Moves a shape here at once; live moves throttled (MOVE_INTERVAL_MS), the final one stored. */
  moveShape(id: string, x: number, y: number, final: boolean): void {
    if (!this.live || isLocalId(id)) return;
    if (!findShape(this.view.board, id)) return this.stopShapeMove(id);
    let board = moveShapeLocal(this.view.board, id, x, y);
    if (final) board = setShapeDragging(board, id, false);
    this.update({ board });
    if (final) {
      this.stopShapeMove(id);
      this.recordRects("Move", ["shape"], [id], ["x", "y"], `move:${id}`);
      return this.sendShapeMove(id, true);
    }
    this.throttle(this.shapeMoves, id, MOVE_INTERVAL_MS, () => this.sendShapeMove(id, false));
  }

  startShapeResize(id: string): boolean {
    if (!this.live || isLocalId(id) || !findShape(this.view.board, id)) return false;
    this.update({ board: setShapeResizing(this.view.board, id, true), noteNotice: null });
    return true;
  }

  /** Resizes a shape here at once (clamped to shape sizes); live resizes throttled, the final one stored. */
  resizeShape(id: string, rect: NoteRect, final: boolean): void {
    if (!this.live || isLocalId(id)) return;
    if (!findShape(this.view.board, id)) return this.stopShapeResize(id);
    let board = resizeShapeLocal(this.view.board, id, rect);
    if (final) board = setShapeResizing(board, id, false);
    this.update({ board });
    if (final) {
      this.stopShapeResize(id);
      this.recordRects("Resize", ["shape"], [id], ["x", "y", "w", "h"], `resize:${id}`);
      return this.sendShapeResize(id, true);
    }
    this.throttle(this.shapeResizes, id, RESIZE_INTERVAL_MS, () => this.sendShapeResize(id, false));
  }

  /** The Width/Height fields: one final resize at the same position. */
  setShapeSize(id: string, w: number, h: number): boolean {
    const entry = findShape(this.view.board, id);
    if (!this.live || isLocalId(id) || !entry) return false;
    const board = resizeShapeLocal(this.view.board, id, { x: entry.shape.x, y: entry.shape.y, w, h });
    if (board === this.view.board) return true;
    this.update({ board, noteNotice: null });
    this.recordRects("Resize", ["shape"], [id], ["x", "y", "w", "h"]);
    this.sendShapeResize(id, true);
    return true;
  }

  /** Deletes a shape here at once (as a one-entry shapeBatch). */
  deleteShape(id: string): void {
    if (!this.live) return;
    const entry = findShape(this.view.board, id);
    if (!entry) return;
    this.stopShapeMove(id);
    this.stopShapeResize(id);
    this.update({ board: deleteShapeLocal(this.view.board, id), noteNotice: null });
    if (entry.clientRef !== null) {
      this.abandonedShapes.add(entry.clientRef);
      this.history.refuse("shape", id);
    } else {
      this.recordRemoval("Delete shape", [], [], [entry.shape]);
      this.send({ type: "shapeDelete", id });
    }
  }

  private sendShapeMove(id: string, final: boolean): void {
    const shape = findShape(this.view.board, id)?.shape;
    if (!shape || !this.live) return;
    this.send({ type: "shapeMove", id, x: shape.x, y: shape.y, final });
  }

  private sendShapeResize(id: string, final: boolean): void {
    const shape = findShape(this.view.board, id)?.shape;
    if (!shape || !this.live) return;
    this.send({ type: "shapeResize", id, x: shape.x, y: shape.y, w: shape.w, h: shape.h, final });
  }

  private stopShapeMove(id: string): void {
    clearTimeout(this.shapeMoves.get(id)?.timer);
    this.shapeMoves.delete(id);
  }

  private stopShapeResize(id: string): void {
    clearTimeout(this.shapeResizes.get(id)?.timer);
    this.shapeResizes.delete(id);
  }

  /** In chunks of MAX_BATCH_ENTRIES. */
  private sendShapeBatch(ops: readonly ShapeBatchEntry[], final: boolean): void {
    if (!this.live) return;
    for (let i = 0; i < ops.length; i += MAX_BATCH_ENTRIES) this.send({ type: "shapeBatch", ops: ops.slice(i, i + MAX_BATCH_ENTRIES), final });
  }

  /** A shape left the board (deleted, by anyone): runs waiting on it stop waiting. */
  private shapeGone(id: string): void {
    this.clearRun?.shapes.ids.delete(id);
  }

  /** A shape deleted here before its add was confirmed: a run waiting on its ref now waits on its id. */
  private shapeConfirmedGone(clientRef: string, id: string): void {
    if (this.clearRun?.shapes.refs.delete(clientRef)) this.clearRun.shapes.ids.add(id);
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
    const run: ItemsRun = { refs: [], pending: new Set(), ids: new Map(), refused: { notesFull: 0, framesFull: 0, shapesFull: 0, invalid: 0, tooQuick: 0 }, template, restore };
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
      } else if (input.kind === "shape") {
        const { kind: _, shapeKind, x, y, w, h, text, ...style } = input;
        const clean = cleanShapeText(text);
        if (clean === null) {
          run.refs.push(null);
          run.refused.invalid++;
          continue;
        }
        const item: ShapeItem = { ref, kind: shapeKind, ...clampShapeRect({ x, y, w, h }), text: clean, ...style };
        board = addShapeItemLocal(board, item, authorId);
        drafts.push({ kind: "shape", item });
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
      for (const { shape } of message.shapes ?? []) board = applyShapeAdded(board, shape);
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
    for (const { ref, shape } of message.shapes ?? []) {
      if (ref === undefined) continue;
      board = this.confirmShape(board, shape, ref);
      this.itemSettled(run, ref, findShape(board, shape.id) ? shape.id : null);
    }
    for (const r of message.refused) {
      const ref = itemList(batch.message, r.kind)?.[r.index]?.ref;
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
      const ref = itemList(batch.message, r.kind)?.[r.index]?.ref;
      if (ref !== undefined) board = this.itemRefused(board, batch.run, ref, r.kind, r.reason);
    }
    const reason = message.code === "notes_full" || message.code === "frames_full" || message.code === "shapes_full" || message.code === "rate_limited" ? message.code : "invalid";
    board = this.refuseUnanswered(board, batch, reason);
    this.update({
      ...(message.code === "rate_limited" ? { rateLimited: true } : {}),
      ...this.itemsDone(batch.run, board),
      // A locked board refused the whole message: say that, once, instead of the item counts.
      ...(message.code === "board_locked" ? { noteNotice: NOTICES.locked } : {}),
    });
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
  private itemRefused(board: Board, run: ItemsRun, ref: string, kind: ItemKind, reason: ItemRefusalReason | "rate_limited"): Board {
    this.itemSettled(run, ref, null);
    this.history.refuse(kind, localId(ref));
    const deletedHere = kind === "note" ? this.abandoned.delete(ref) : kind === "frame" ? this.abandonedFrames.delete(ref) : this.abandonedShapes.delete(ref);
    if (deletedHere) {
      this.deleteRun?.refs.delete(ref);
      this.clearRun?.notes.refs.delete(ref);
      this.clearRun?.frames.refs.delete(ref);
    }
    else run.refused[refusalKey(reason)]++;
    return kind === "note" ? rejectAdd(board, ref) : kind === "frame" ? rejectFrameAdd(board, ref) : rejectShapeAdd(board, ref);
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
      for (const { ref } of batch.message.shapes ?? []) {
        this.itemSettled(batch.run, ref, null);
        this.history.refuse("shape", localId(ref));
        board = rejectShapeAdd(board, ref);
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

  /**
   * Duplicates a selection with frames (v0.20.0) through addItems: frames copied alone (the notes
   * inside only if they're selected too) and notes with everything, offset once and clamped as a
   * group (canvas/duplicate.ts). Refused, sending nothing, as duplicateNotes is, for a guest on a
   * locked board, and when the board hasn't room for every copy (a notice gives the counts). The
   * copies' local ids by kind, or null.
   */
  duplicateSelection(noteIds: readonly string[], frameIds: readonly string[], shapeIds: readonly string[] = []): { notes: string[]; frames: string[]; shapes: string[] } | null {
    if (!this.live || lockedOut(this.view) || noteIds.length + frameIds.length + shapeIds.length === 0) return null;
    const notes = noteIds.map((id) => findNote(this.view.board, id));
    const frames = frameIds.map((id) => findFrame(this.view.board, id));
    const shapes = shapeIds.map((id) => findShape(this.view.board, id));
    if (notes.some((e) => !e || e.confirmed === null || isLocalId(e.note.id) || isHeld(e))) return null;
    if (frames.some((e) => !e || e.confirmed === null || isLocalId(e.frame.id) || isFrameHeld(e))) return null;
    if (shapes.some((e) => !e || e.confirmed === null || isLocalId(e.shape.id) || isShapeHeld(e))) return null;
    const freeShapes = Math.max(0, MAX_SHAPES_PER_ROOM - this.view.board.shapes.length);
    if (shapes.length > freeShapes) {
      this.update({ noteNotice: DUPLICATE_HINTS.shapesFull(shapes.length, freeShapes) });
      return null;
    }
    const freeFrames = Math.max(0, MAX_FRAMES_PER_ROOM - this.view.board.frames.length);
    const freeNotes = Math.max(0, MAX_NOTES_PER_ROOM - this.view.board.notes.length);
    if (frames.length > freeFrames) {
      this.update({ noteNotice: frames.length === 1 ? NOTICES.duplicateNoRoom("frame", 1, freeFrames) : DUPLICATE_HINTS.framesFullMany(frames.length, freeFrames) });
      return null;
    }
    if (notes.length > freeNotes) {
      this.update({ noteNotice: NOTICES.duplicateNoRoom("note", notes.length, freeNotes) });
      return null;
    }
    if (this.itemBatches.size > 0) return null;
    const inputs = duplicateSelectionInputs(
      notes.flatMap((e) => (e ? [e.note] : [])),
      frames.flatMap((e) => (e ? [e.frame] : [])),
      undefined,
      shapes.flatMap((e) => (e ? [e.shape] : [])),
    );
    const ids = this.addItems(inputs, "Duplicate");
    if (!ids) return null;
    const out = { notes: [] as string[], frames: [] as string[], shapes: [] as string[] };
    inputs.forEach((input, i) => {
      const id = ids[i];
      if (id) (input.kind === "frame" ? out.frames : input.kind === "shape" ? out.shapes : out.notes).push(id);
    });
    return out;
  }

  /* ── Clear board ────────────────────────────────────────────────── */

  /**
   * Deletes every note and frame, for everyone: the notes first as batches of deletes (as Delete
   * does, unconfirmed ones once confirmed), then the frames one frameDelete each, every
   * CLEAR_FRAME_STEP_MS. One history step holds whatever was actually deleted, so one undo brings
   * it back. Nothing is retried; `deleteReport` says how it went once everything is answered.
   * Refused (false, nothing sent) while disconnected, on an empty board, while an add run (a
   * template, a duplicate, a restore) is being sent, or while another clear runs.
   */
  clearBoard(): boolean {
    if (!this.live || this.clearRun || this.restoreRun || this.template || this.itemBatches.size > 0) return false;
    const { notes, frames, shapes } = this.view.board;
    if (notes.length + frames.length + shapes.length === 0) return false;
    this.startRemoval("clear", notes, frames, shapes);
    return true;
  }

  /**
   * Deletes a selection with frames (several, or frames and notes; v0.20.0) the way Clear board
   * deletes everything: notes as batches of deletes, then one frameDelete every
   * CLEAR_FRAME_STEP_MS, one history step, one report (`deleteReport`) once everything is
   * answered; `deleting` while it runs. Notes inside the frames that aren't selected stay. Not
   * connected: nothing is deleted, and the report says so. Refused (false, nothing sent) for a guest
   * on a locked board, while a clear or another such delete runs, or while an add run is being sent.
   */
  deleteSelection(noteIds: readonly string[], frameIds: readonly string[], shapeIds: readonly string[] = []): boolean {
    if (this.stopped) return false;
    if (!this.live) {
      this.update({ deleteReport: DELETE_OFFLINE });
      return false;
    }
    if (lockedOut(this.view) || this.clearRun || this.restoreRun || this.template || this.itemBatches.size > 0) return false;
    const notes = noteIds.flatMap((id) => findNote(this.view.board, id) ?? []);
    const frames = frameIds.flatMap((id) => findFrame(this.view.board, id) ?? []);
    const shapes = shapeIds.flatMap((id) => findShape(this.view.board, id) ?? []);
    if (notes.length + frames.length + shapes.length === 0) return false;
    this.startRemoval("delete", notes, frames, shapes);
    return true;
  }

  /** Starts a clear or a selection delete: notes at once (batches), frames queued and paced. */
  private startRemoval(kind: ClearRun["kind"], notes: readonly BoardNote[], frames: readonly BoardFrame[], shapes: readonly BoardShape[] = []): void {
    const part = (): ClearPart => ({ total: 0, ids: new Set(), refs: new Set(), refused: 0, tooQuick: false });
    const run: ClearRun = { kind, notes: part(), frames: { ...part(), queue: [] }, shapes: part() };
    let board = this.view.board;
    const ops: NoteBatchEntry[] = [];
    const removedNotes: Note[] = [];
    for (const entry of notes) {
      const id = entry.note.id;
      this.stopMove(id);
      this.stopResize(id);
      board = deleteLocal(board, id);
      run.notes.total++;
      if (entry.clientRef !== null) {
        this.abandoned.add(entry.clientRef);
        run.notes.refs.add(entry.clientRef);
        this.history.refuse("note", id);
      } else {
        ops.push({ op: "delete", id });
        run.notes.ids.add(id);
        removedNotes.push(entry.note);
      }
    }
    const removedFrames: Frame[] = [];
    for (const entry of frames) {
      const id = entry.frame.id;
      run.frames.total++;
      if (entry.clientRef !== null) {
        // Not on the relay yet: gone here now, deleted once confirmed.
        board = deleteFrameLocal(board, id);
        this.abandonedFrames.add(entry.clientRef);
        run.frames.refs.add(entry.clientRef);
        this.history.refuse("frame", id);
      } else {
        run.frames.queue.push(id);
        removedFrames.push(entry.frame);
      }
    }
    // Shapes (protocol v15): deleted at once in shapeBatch chunks, like notes.
    const shapeOps: ShapeBatchEntry[] = [];
    const removedShapes: Shape[] = [];
    for (const entry of shapes) {
      const id = entry.shape.id;
      this.stopShapeMove(id);
      this.stopShapeResize(id);
      board = deleteShapeLocal(board, id);
      run.shapes.total++;
      if (entry.clientRef !== null) {
        this.abandonedShapes.add(entry.clientRef);
        run.shapes.refs.add(entry.clientRef);
        this.history.refuse("shape", id);
      } else {
        shapeOps.push({ op: "delete", id });
        run.shapes.ids.add(id);
        removedShapes.push(entry.shape);
      }
    }
    this.clearRun = run;
    this.update({ board, noteNotice: null });
    const label = kind === "clear" ? "Clear board" : "Delete";
    this.recordRemoval(label, removedNotes, removedFrames, removedShapes);
    this.sendBatch(ops, true);
    this.sendShapeBatch(shapeOps, true);
    this.pumpClear();
  }

  /** Sends the next frameDelete of a clear, then waits CLEAR_FRAME_STEP_MS. */
  private pumpClear(): void {
    const run = this.clearRun;
    if (!run || this.clearTimer !== undefined || !this.live) return;
    const id = run.frames.queue.shift();
    if (id === undefined) return this.settleClear();
    const entry = findFrame(this.view.board, id);
    if (entry) {
      this.stopFrameMove(id);
      this.stopFrameResize(id);
      run.frames.ids.add(id);
      this.update({ board: deleteFrameLocal(this.view.board, id) });
      this.send({ type: "frameDelete", id });
    }
    this.clearTimer = setTimeout(() => {
      this.clearTimer = undefined;
      this.pumpClear();
    }, CLEAR_FRAME_STEP_MS);
  }

  /** Reports the clear once nothing in it is left to send or hear about. */
  private settleClear(): void {
    const run = this.clearRun;
    if (!run) return;
    const { notes, frames, shapes } = run;
    if (notes.ids.size + notes.refs.size + frames.ids.size + frames.refs.size + frames.queue.length + shapes.ids.size + shapes.refs.size > 0) return;
    this.clearRun = null;
    this.update({ deleteReport: removalReportFor(run.kind, { ...notes, lost: 0 }, { ...frames, lost: 0 }, { ...shapes, lost: 0 }) });
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
    // A guest on a locked board: the relay would refuse it (courtesy; it's still the authority).
    if (lockedOut(this.view)) return { undo: LOCK_TEXT.reason, redo: LOCK_TEXT.reason };
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
    if (kind === "shape") {
      const entry = findShape(this.view.board, id);
      if (!entry?.confirmed) return null;
      return { rev: entry.confirmed.rev, held: isShapeHeld(entry) || entry.draft !== null, state: entry.confirmed as unknown as Fields };
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
      const inputs = plan.restores.map((r) => itemInput(r.kind, r.content));
      restore = this.startItems(inputs, null, { restore: true, defer: true });
      board = this.view.board;
      plan.restores.forEach((r, i) => {
        const ref = restore?.refs[i];
        if (ref) newIds.set(`${r.kind}:${r.id}`, localId(ref));
      });
    }
    this.history.applied(plan, newIds, now);

    const ops: NoteBatchEntry[] = [];
    const shapeOps: ShapeBatchEntry[] = [];
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
      if (kind === "shape") {
        const before = findShape(board, id)?.shape;
        if (!before) continue;
        if (hasRect) {
          board = resizeShapeLocal(board, id, { x: x ?? before.x, y: y ?? before.y, w: w ?? before.w, h: h ?? before.h });
          const after = findShape(board, id)?.shape ?? before;
          shapeOps.push(w === undefined && h === undefined ? { op: "move", id, x: after.x, y: after.y } : { op: "resize", id, x: after.x, y: after.y, w: after.w, h: after.h });
        }
        if (Object.keys(fields).length > 0) {
          board = editShapeLocal(board, id, fields as ShapeEdit);
          sends.push({ type: "shapeEdit", id, ...(fields as ShapeEdit) });
        }
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
      } else if (kind === "shape") {
        this.stopShapeMove(id);
        this.stopShapeResize(id);
        board = deleteShapeLocal(board, id);
        shapeOps.push({ op: "delete", id });
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
    this.sendShapeBatch(shapeOps, true);
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
      const shown: NoteRect | undefined = kind === "note" ? findNote(this.view.board, id)?.note : kind === "shape" ? findShape(this.view.board, id)?.shape : findFrame(this.view.board, id)?.frame;
      return shown ? [{ kind, id, after: Object.fromEntries(keys.map((k) => [k, shown[k]])) }] : [];
    });
    this.record(label, changes, coalesce);
  }

  /** What the relay has (or will have, from my changes in flight) for these fields; null for an unconfirmed item. */
  private storedFields(kind: ItemKind, id: string, keys: readonly string[]): Fields | null {
    const confirmed = (
      kind === "note" ? findNote(this.view.board, id)?.confirmed : kind === "shape" ? findShape(this.view.board, id)?.confirmed : findFrame(this.view.board, id)?.confirmed
    ) as unknown as Fields | null | undefined;
    if (!confirmed) return null;
    const pending = this.history.pendingValues(kind, id);
    return Object.fromEntries(keys.flatMap((k) => {
      const v = pending[k] ?? confirmed[k];
      return v === undefined ? [] : [[k, v]];
    }));
  }

  /** Records items I deleted (confirmed only), with their content and z, to add them back on undo. */
  private recordRemoval(label: string, notes: readonly Note[], frames: readonly Frame[], shapes: readonly Shape[] = []): void {
    const board = this.view.board;
    const rev = (kind: ItemKind, id: string) =>
      (kind === "note"
        ? (findNote(board, id) ?? board.removed.find((n) => n.note.id === id))?.confirmed?.rev
        : kind === "shape"
          ? (findShape(board, id) ?? board.shapesRemoved.find((s) => s.shape.id === id))?.confirmed?.rev
          : (findFrame(board, id) ?? board.framesRemoved.find((f) => f.frame.id === id))?.confirmed?.rev) ?? 1;
    this.history.recordRemove(
      label,
      [
        ...notes.filter((n) => !isLocalId(n.id)).map((n) => ({ kind: "note" as const, id: n.id, content: n as unknown as Fields, z: n.z, rev: rev("note", n.id) })),
        ...frames.filter((f) => !isLocalId(f.id)).map((f) => ({ kind: "frame" as const, id: f.id, content: f as unknown as Fields, z: 0, rev: rev("frame", f.id) })),
        ...shapes.filter((x) => !isLocalId(x.id)).map((x) => ({ kind: "shape" as const, id: x.id, content: x as unknown as Fields, z: x.z, rev: rev("shape", x.id) })),
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
    const shapesBefore = new Map([...before.shapes, ...before.shapesRemoved].map((x) => [x.shape.id, x.confirmed] as const));
    const shapesAfter = new Map([...after.shapes, ...after.shapesRemoved].map((x) => [x.shape.id, x.confirmed] as const));
    for (const [id, confirmed] of shapesAfter) {
      const prev = shapesBefore.get(id);
      if (!confirmed || !prev || prev === confirmed) continue;
      const zOnly = (Object.keys(confirmed) as (keyof Shape)[]).every((k) => k === "z" || k === "rev" || confirmed[k] === prev[k]);
      this.history.observe("shape", id, prev.rev, confirmed.rev, confirmed as unknown as Fields, zOnly);
    }
    for (const id of shapesBefore.keys()) if (!shapesAfter.has(id) && !isLocalId(id)) this.history.deleted("shape", id);
    // A change confirmed may make undo or redo possible.
    this.refreshHistory();
  }

  /** Reports undo and redo's reasons if they changed (a step recorded, or confirmed). */
  private refreshHistory(): void {
    if (this.stopped) return;
    const reasons = this.historyReasons();
    this.armExpiry();
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

  private sendFrameMove(id: string, noteIds: readonly string[], final: boolean, shapeIds: readonly string[] = []): void {
    const frame = findFrame(this.view.board, id)?.frame;
    if (!frame || !this.live) return;
    this.send({
      type: "frameMove",
      id,
      x: frame.x,
      y: frame.y,
      final,
      ...(noteIds.length > 0 ? { noteIds: [...noteIds] } : {}),
      ...(shapeIds.length > 0 ? { shapeIds: [...shapeIds] } : {}),
    });
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
    for (const id of [...this.shapeMoves.keys()]) this.stopShapeMove(id);
    for (const id of [...this.shapeResizes.keys()]) this.stopShapeResize(id);
    this.frameDrag = null;
    this.stopGroup();
    this.stopSelectionDrag();
    // Nothing queued is sent later: there's no offline queue.
    clearTimeout(this.frameEditTimer);
    this.frameEditTimer = undefined;
    this.frameEditQueue = [];
  }

  /* ── Live cursors (protocol v14) ────────────────────────────────── */

  /**
   * Shares my pointer at a board position (whole units). Only while joined, visible, and with
   * someone else here; false (nothing sent) otherwise. The caller throttles (cursors/cursors.ts).
   * Sent straight to the socket: no view update, no history.
   */
  shareCursor(x: number, y: number): boolean {
    if (!this.live || this.env.hidden() || !this.othersHere()) return false;
    this.sendCursor({ type: "cursor", x: Math.round(x), y: Math.round(y) });
    this.cursorShown = true;
    return true;
  }

  /** My pointer left the board (or the window, or sharing was switched off): cursorLeft once, if it was shown. */
  hideCursor(): void {
    if (!this.cursorShown) return;
    this.cursorShown = false;
    if (this.live) this.sendCursor({ type: "cursorLeft" });
  }

  private othersHere(): boolean {
    return this.view.participants.some((p) => !this.yourIds.has(p.id));
  }

  private sendCursor(message: Extract<ClientMessage, { type: "cursor" | "cursorLeft" }>): void {
    try {
      this.socket?.send(encodeMessage(message));
    } catch {
      // The close handler reports the lost connection.
    }
  }

  /** Someone else's pointer: only from a participant here now, never my own (any of my ids this visit). */
  private otherCursor(message: Extract<ServerMessage, { type: "cursorMoved" | "cursorGone" }>): void {
    const sink = this.options.cursors;
    if (!sink) return;
    if (message.type === "cursorGone") return sink.gone(message.id);
    if (this.yourIds.has(message.id) || !this.view.participants.some((p) => p.id === message.id)) return;
    sink.moved(message.id, message.x, message.y);
  }

  /** The connection or the visit ended: no pointer is shown either way. */
  private forgetCursors(): void {
    this.cursorShown = false;
    this.options.cursors?.clear();
  }

  /** Leaves: closes the socket and reports nothing further. */
  close(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.stopRetry();
    this.unlisten?.();
    this.unlisten = null;
    clearTimeout(this.expiryTimer);
    clearTimeout(this.presenceTimer);
    clearTimeout(this.toastTimer);
    clearTimeout(this.itemTimer);
    this.template = null;
    this.restoreRun = null;
    this.clearRun = null;
    clearTimeout(this.clearTimer);
    this.history.clear();
    this.stopAllMoves();
    this.forgetCursors();
    this.socket?.close();
  }

  private onOpen(): void {
    if (this.stopped) return;
    this.opened = true;
    this.send({ type: "hello", protocolVersion: PROTOCOL_VERSION });
  }

  private onClose(code?: number): void {
    if (this.stopped) return;
    const { status } = this.view;
    if (status === "invalid" || status === "full" || status === "reload" || status === "unreachable" || status === "expired" || status === "ended") return;
    // The room has expired, or a host ended it: final, on a first join or a reconnect alike (and only these codes).
    if (code === ROOM_EXPIRED_CLOSE_CODE) return this.roomGone("expired");
    if (code === ROOM_ENDED_CLOSE_CODE) return this.roomGone("ended");
    if (status === "joined") {
      this.detach(false);
      return this.dropped();
    }
    // A reconnect's try that closed (or never opened).
    if (this.retry) return this.tryFailed(this.opened);
    clearTimeout(this.timer);
    this.stopAllMoves();
    this.socket = null;
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
    // Pointers (protocol v14) go straight to the cursor sink: never a view update, so nothing re-renders for them.
    if (parsed.value.type === "cursorMoved" || parsed.value.type === "cursorGone") return this.otherCursor(parsed.value);
    const before = this.view.board;
    this.handle(parsed.value);
    this.pruneVotes();
    this.observe(before, this.view.board);
    this.settleClear();
  }

  private handle(message: ServerMessage): void {
    switch (message.type) {
      case "welcome":
        if (message.protocolVersion !== PROTOCOL_VERSION) return this.finish("reload");
        this.welcomed = true;
        if (this.pendingName !== null) this.send({ type: "join", name: this.pendingName });
        return;

      case "joined":
        // A new visit (or a reconnect): pointers seen before are stale.
        this.cursorShown = false;
        this.options.cursors?.clear();
        for (const p of message.participants) this.known.set(p.id, p);
        this.known.set(message.you.id, message.you);
        this.yourIds.add(message.you.id);
        this.joinedName = message.you.name;
        // Protocol v12: the room's lock and timer come with joined; host powers are claimed again
        // on every join and reconnect (a new participant), with the token kept on this device.
        const roomState = { locked: message.locked, timer: roomTimer(message.timer), isHost: message.you.host, lockPending: null, ...this.votingFrom(message.voting), isVoter: false };
        if (this.retry) {
          // A reconnect: live once the snapshot has replaced the board (the join timer runs till then).
          this.resyncing = true;
          this.quietUntil = Date.now() + RESYNC_QUIET_MS;
          this.update({ you: message.you, participants: message.participants, nameError: false, people: new Map(this.known), yourIds: new Set(this.yourIds), ...roomState });
          return this.claimHost();
        }
        clearTimeout(this.timer);
        this.update({
          yourIds: new Set(this.yourIds),
          status: "joined",
          you: message.you,
          participants: message.participants,
          nameError: false,
          people: new Map(this.known),
          ...roomState,
        });
        return this.claimHost();

      case "hostGranted": {
        const you = this.view.you ? { ...this.view.you, host: true } : null;
        if (you) this.known.set(you.id, you);
        return this.update({
          isHost: true,
          you,
          participants: this.view.participants.map((p) => (p.id === you?.id ? you : p)),
          people: new Map(this.known),
        });
      }

      case "participantUpdated": {
        const p = message.participant;
        this.known.set(p.id, p);
        return this.update({
          participants: this.view.participants.map((q) => (q.id === p.id ? p : q)),
          ...(this.view.you?.id === p.id ? { you: p, isHost: p.host } : {}),
          people: new Map(this.known),
        });
      }

      case "lockChanged":
        return this.update({ locked: message.locked, lockPending: null });

      case "timerChanged":
        return this.update({ timer: roomTimer(message.timer) });

      case "sessionEnded":
        // A host ended the session: final. The relay closes the socket with 4411 next.
        return this.roomGone("ended");

      case "voterGranted": {
        // The relay's word on my votes (a reconnect or another tab may have changed them).
        this.votesConfirmed.clear();
        for (const v of message.mine) this.votesConfirmed.set(v.noteId, v.count);
        this.votesPending.clear();
        this.votesLeft = message.remaining;
        this.votersFull = false;
        return this.update({ isVoter: true, votersFull: false, ...this.voteView() });
      }

      case "votingChanged": {
        const newRound = message.voting.round !== this.view.voting.round;
        this.update(this.votingFrom(message.voting));
        // A page left without a voter (the last round was full) tries again for a new round.
        if (newRound && message.voting.state === "open" && !this.view.isVoter && this.view.status === "joined") {
          this.votersFull = false;
          this.update({ votersFull: false });
          this.claimVoter();
        }
        return;
      }

      case "voteConfirmed": {
        if (message.count > 0) this.votesConfirmed.set(message.noteId, message.count);
        else this.votesConfirmed.delete(message.noteId);
        this.votesLeft = message.remaining;
        // Mine, answered in order; a confirmation from my other tab leaves this page's waiting votes alone.
        const pending = this.votesPending.get(message.noteId);
        if (pending?.[0] === message.count) this.shiftPendingVote(message.noteId);
        return this.update(this.voteView());
      }

      case "votesRevealed": {
        const { voting } = this.view;
        if (voting.state !== "closed" || message.round !== voting.round) return;
        return this.update({ results: message.totals.map(({ noteId, count }) => ({ noteId, count })) });
      }

      case "participant_joined": {
        const p = message.participant;
        this.known.set(p.id, p);
        const others = this.view.participants.filter((q) => q.id !== p.id);
        // Not news: yourself, or someone back after your own reconnect.
        // Back soon after their leave was shown, or back before the relay noticed they'd gone.
        const back = Date.now() - (this.recentlyLeft.get(p.name) ?? -Infinity) < RESYNC_QUIET_MS || others.some((q) => q.name === p.name);
        const quiet = (Date.now() < this.quietUntil && this.quietNames.has(p.name)) || back;
        if (this.yourIds.has(p.id)) {
          // Yourself: never a toast.
        } else if (!quiet) this.presence({ kind: "joined", id: p.id, name: p.name });
        else {
          // Not news, but it still cancels their leave waiting to be shown (a quick reconnect).
          const leave = this.presenceEvents.findIndex((e) => e.kind === "left" && e.name === p.name);
          if (leave >= 0) this.presenceEvents.splice(leave, 1);
        }
        return this.update({ participants: [...others, p], people: new Map(this.known) });
      }

      case "participant_left": {
        this.options.cursors?.gone(message.id);
        const gone = this.view.participants.find((p) => p.id === message.id);
        if (!gone) return;
        // An old socket of someone who is back already (same name, new id) isn't news.
        if (!this.view.participants.some((p) => p.id !== gone.id && p.name === gone.name)) this.presence({ kind: "left", id: gone.id, name: gone.name });
        return this.update({ participants: this.view.participants.filter((p) => p.id !== message.id) });
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

      case "snapshot": {
        // A (re)sync: what the history knows about ids and revs can't be trusted any more.
        this.history.clear();
        if (this.resyncing) this.options.cursors?.clear();
        if (!this.resyncing) return this.update({ board: applySnapshot(this.view.board, message.notes), synced: true });
        // After a reconnect the relay's notes replace the board; its frames follow (framesSnapshot).
        clearTimeout(this.timer);
        this.resyncing = false;
        this.framesResync = true;
        this.shapesResync = true;
        this.stopRetry();
        const { board, orphans } = resyncNotes(this.view.board, message.notes);
        return this.update({ status: "joined", board, synced: true, ...(orphans.length > 0 ? { orphanDraft: orphans.at(-1) ?? null } : {}) });
      }

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
        if (this.framesResync) {
          this.framesResync = false;
          return this.update({ board: resyncFrames(this.view.board, message.frames) });
        }
        return this.update({ board: applyFramesSnapshot(this.view.board, message.frames) });

      case "shapesSnapshot":
        // Right after the frames snapshot (protocol v15). Shapes slot in; no viewport jump.
        if (this.shapesResync) {
          this.shapesResync = false;
          return this.update({ board: resyncShapes(this.view.board, message.shapes) });
        }
        return this.update({ board: applyShapesSnapshot(this.view.board, message.shapes) });

      case "shapeAdded": {
        const { shape, clientRef } = message;
        return this.update({ board: this.confirmShape(this.view.board, shape, clientRef), ...(clientRef !== undefined ? { rateLimited: false } : {}) });
      }

      case "shapeUpdated":
        return this.update({ board: applyShapeUpdated(this.view.board, message.shape) });

      case "shapeMoved":
        return this.update({ board: applyShapeMoved(this.view.board, message) });

      case "shapeResized":
        return this.update({ board: applyShapeResized(this.view.board, message) });

      case "shapeDeleted": {
        this.stopShapeMove(message.id);
        this.stopShapeResize(message.id);
        const editing = findShape(this.view.board, message.id)?.draft != null;
        this.shapeGone(message.id);
        return this.update({
          board: applyShapeDeleted(this.view.board, message.id),
          ...(editing ? { noteNotice: NOTICES.shapeDeletedWhileEditing } : {}),
          ...this.deleteSettled(),
        });
      }

      case "shapesBatchApplied": {
        let board = this.view.board;
        let editingDeleted = false;
        for (const result of message.results) {
          if (result.type === "shapeMoved") board = applyShapeMoved(board, result);
          else if (result.type === "shapeResized") board = applyShapeResized(board, result);
          else {
            this.stopShapeMove(result.id);
            this.stopShapeResize(result.id);
            editingDeleted ||= findShape(board, result.id)?.draft != null;
            board = applyShapeDeleted(board, result.id);
            this.shapeGone(result.id);
          }
        }
        return this.update({ board, ...(editingDeleted ? { noteNotice: NOTICES.shapeDeletedWhileEditing } : {}), ...this.deleteSettled() });
      }

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
        for (const x of message.shapes ?? []) board = applyShapeMoved(board, { ...x, final: message.final });
        return this.update({ board });
      }

      case "frameResized":
        return this.update({ board: applyFrameResized(this.view.board, message) });

      case "frameDeleted":
        this.clearRun?.frames.ids.delete(message.id);
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
        if (message.noteId !== undefined && this.votesPending.has(message.noteId) && (VOTE_REFUSALS.has(message.code) || message.code === "rate_limited")) {
          return this.voteRefused(message.noteId, message.code);
        }
        if (message.code === "voters_full" && message.noteId === undefined) {
          // claimVoter refused: this round has its voters. Said when a vote is tried.
          this.votersFull = true;
          return this.update({ isVoter: false, votersFull: true });
        }
        const batch = message.clientRef === undefined ? undefined : this.itemBatches.get(message.clientRef);
        if (batch) return this.itemsErrored(message, batch);
        if (
          message.clientRef !== undefined ||
          message.noteId !== undefined ||
          message.noteIds !== undefined ||
          message.frameId !== undefined ||
          message.shapeId !== undefined ||
          message.shapeIds !== undefined
        ) {
          return this.noteRefused(message);
        }
        switch (message.code) {
          case "version_mismatch":
            return this.finish("reload");
          case "room_full":
            if (this.retry) return this.retryStopped("full");
            return this.finish("full");
          case "invalid_name":
            clearTimeout(this.timer);
            // The stored name was refused on a reconnect: stop and offer Rejoin (with the name that worked).
            if (this.retry) return this.retryStopped("offline");
            return this.update({ status: "idle", nameError: true });
          case "rate_limited":
            return this.update({ rateLimited: true });
          case "notes_full":
            return this.update({ noteNotice: NOTICES.full });
          case "frames_full":
            return this.update({ noteNotice: NOTICES.framesFull });
          case "shapes_full":
            return this.update({ noteNotice: NOTICES.shapesFull });
          case "board_locked":
            return this.update({ noteNotice: NOTICES.locked });
          case "not_host":
            return this.update({ noteNotice: NOTICES.notHost, lockPending: null });
          case "bad_host_token":
            // The stored token doesn't open this room: forget it, quietly (nothing visible depends on it yet).
            this.options.forgetHostToken?.();
            return this.update({ isHost: false });
          case "over_budget":
          case "voting_closed":
          case "no_voter":
          case "voters_full":
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
      if (this.deleteRun?.refs.delete(clientRef)) this.deleteRun.ids.add(note.id);
      if (this.clearRun?.notes.refs.delete(clientRef)) this.clearRun.notes.ids.add(note.id);
      this.send({ type: "noteDelete", id: note.id });
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
      if (this.clearRun?.frames.refs.delete(clientRef)) this.clearRun.frames.ids.add(frame.id);
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

  /** A shape add confirmed (a shapeAdd's, or an itemsAdd entry's by its ref), likewise. */
  private confirmShape(board: Board, shape: Shape, clientRef: string | undefined): Board {
    const temp = clientRef === undefined ? undefined : findShape(board, localId(clientRef));
    let next = applyShapeAdded(board, shape, clientRef);
    if (clientRef !== undefined && this.abandonedShapes.delete(clientRef)) {
      next = deleteShapeLocal(next, shape.id);
      this.shapeConfirmedGone(clientRef, shape.id);
      this.send({ type: "shapeBatch", ops: [{ op: "delete", id: shape.id }], final: true });
    } else if (temp) {
      this.history.confirmAdd("shape", temp.shape.id, shape.id, shape.rev);
      // Text or style set while the add was in flight: one edit with all of it.
      const edit = shapeChanges(shape, temp.shape);
      if (Object.keys(edit).length > 0) {
        this.history.expectOwn("shape", shape.id, edit as Fields, Date.now());
        this.send({ type: "shapeEdit", id: shape.id, ...edit });
      }
    }
    if (temp) this.options.onShapeConfirmed?.(temp.shape.id, shape.id);
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
    // Refusals that only touch a clear in flight are told in its report too.
    const clear = this.clearRun;
    if (clear) {
      let all = true;
      if (message.clientRef !== undefined && !clear.notes.refs.delete(message.clientRef) && !clear.frames.refs.delete(message.clientRef) && !clear.shapes.refs.delete(message.clientRef)) all = false;
      for (const id of noteIds) {
        if (clear.notes.ids.delete(id)) {
          clear.notes.refused++;
          clear.notes.tooQuick ||= message.code === "rate_limited";
        } else all = false;
      }
      if (message.frameId !== undefined) {
        if (clear.frames.ids.delete(message.frameId)) {
          clear.frames.refused++;
          clear.frames.tooQuick ||= message.code === "rate_limited";
        } else all = false;
      }
      const refusedShapes = [...(message.shapeId !== undefined ? [message.shapeId] : []), ...(message.shapeIds ?? [])];
      for (const id of refusedShapes) {
        if (clear.shapes.ids.delete(id)) {
          clear.shapes.refused++;
          clear.shapes.tooQuick ||= message.code === "rate_limited";
        } else all = false;
      }
      if (all && (message.clientRef !== undefined || noteIds.length > 0 || message.frameId !== undefined || refusedShapes.length > 0)) ours = true;
    }
    if (message.clientRef !== undefined) {
      this.history.refuse("note", localId(message.clientRef));
      this.history.refuse("frame", localId(message.clientRef));
      this.history.refuse("shape", localId(message.clientRef));
      // A clientRef belongs to one add, a note's, a frame's or a shape's.
      this.abandoned.delete(message.clientRef);
      this.abandonedFrames.delete(message.clientRef);
      this.abandonedShapes.delete(message.clientRef);
      board = rejectShapeAdd(rejectFrameAdd(rejectAdd(board, message.clientRef), message.clientRef), message.clientRef);
    }
    // One shape, or the shapes a refused batch or carry named (protocol v15).
    const shapeIds = [...(message.shapeId !== undefined ? [message.shapeId] : []), ...(message.shapeIds ?? [])];
    for (const id of [...shapeIds].reverse()) {
      this.history.refuse("shape", id);
      this.stopShapeMove(id);
      this.stopShapeResize(id);
      board = rollbackShape(board, id);
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
          : message.code === "shapes_full"
            ? NOTICES.shapesFull
          : message.code === "rate_limited"
            ? NOTICES.tooQuick
            : message.code === "board_locked"
              ? NOTICES.locked
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
      if (this.retry?.trying) return this.tryFailed(this.opened);
      if (this.view.status === "connecting") this.finish("unreachable");
    }, JOIN_TIMEOUT_MS);
  }

  /** A reconnect stops without retrying by itself (the session filled up, or the name was refused): Rejoin. */
  private retryStopped(phase: "full" | "offline"): void {
    const r = this.retry;
    if (!r) return;
    clearTimeout(this.timer);
    clearTimeout(r.timer);
    r.timer = undefined;
    this.detach(true);
    r.trying = false;
    this.resyncing = false;
    r.phase = phase;
    this.update({});
  }

  /**
   * The relay says the room has expired (4410) or a host ended it (sessionEnded, 4411). Its board
   * is gone, so everything goes with it: retries, probes, browser listeners, queued work, runs,
   * the undo history and this device's host token. Nothing is tried again; the page shows the
   * matching message instead of the board.
   */
  private roomGone(status: "expired" | "ended"): void {
    this.options.forgetHostToken?.();
    this.options.forgetVoterKey?.();
    this.votesConfirmed.clear();
    this.votesPending.clear();
    this.votesLeft = VOTE_BUDGET_DEFAULT;
    this.votersFull = false;
    clearTimeout(this.timer);
    this.stopRetry();
    this.unlisten?.();
    this.unlisten = null;
    clearTimeout(this.itemTimer);
    this.itemTimer = undefined;
    this.itemQueue = [];
    this.itemBatches.clear();
    clearTimeout(this.clearTimer);
    this.clearTimer = undefined;
    this.clearRun = null;
    this.restoreRun = null;
    this.deleteRun = null;
    this.template = null;
    this.abandoned.clear();
    this.abandonedFrames.clear();
    this.abandonedShapes.clear();
    clearTimeout(this.presenceTimer);
    clearTimeout(this.toastTimer);
    this.history.clear();
    this.stopAllMoves();
    this.forgetCursors();
    this.detach(true);
    this.update({
      status,
      isHost: false,
      locked: false,
      timer: null,
      lockPending: null,
      voting: VOTING_OFF,
      isVoter: false,
      votersFull: false,
      myVotes: new Map(),
      remaining: VOTE_BUDGET_DEFAULT,
      results: null,
      board: EMPTY_BOARD,
      synced: false,
      presenceToast: null,
      noteNotice: null,
      deleteReport: null,
      historyReport: null,
      dropReport: null,
      orphanDraft: null,
    });
  }

  /** Host commands (facilitation UI) go out only from a live host; the relay checks again (not_host). */
  private canHost(): boolean {
    return !this.stopped && this.view.status === "joined" && this.view.isHost;
  }

  /** A run is going (an itemsAdd run, a restore, a clear, a template): End session and the voting commands wait. */
  private running(): boolean {
    return this.itemBatches.size > 0 || this.restoreRun !== null || this.clearRun !== null || this.template !== null;
  }

  /** Host: starts (or replaces) the room's timer. False (nothing sent) outside the relay's bounds, for a guest or while disconnected. */
  startRoomTimer(durationMs: number): boolean {
    if (!this.canHost() || !validDuration(durationMs)) return false;
    this.send({ type: "timerStart", durationMs });
    return true;
  }

  /**
   * Host: locks or unlocks the board. Not optimistic: `lockPending` says what was asked until the
   * relay's lockChanged (or a refusal, or a drop). A second press while waiting sends nothing.
   */
  setLock(locked: boolean): boolean {
    if (!this.canHost() || this.view.lockPending !== null) return false;
    this.send({ type: "lockSet", locked });
    this.update({ lockPending: locked });
    return true;
  }

  /**
   * Host: ends the session for everyone (the relay deletes it; sessionEnded and 4411 follow). Not
   * while disconnected or while a run (a template, a duplicate, a restore, a clear) is going.
   */
  endSession(): boolean {
    if (!this.canHost() || this.running()) return false;
    this.send({ type: "endSession" });
    return true;
  }

  /** Host: stops the room's timer. */
  stopRoomTimer(): boolean {
    if (!this.canHost()) return false;
    this.send({ type: "timerStop" });
    return true;
  }

  /** Protocol v12: claims host powers with this room's token, if this device has one. Never shown or logged. */
  private claimHost(): void {
    const token = this.options.hostToken?.();
    if (token) this.send({ type: "claimHost", token });
    this.claimVoter();
  }

  /* ── Dot voting (protocol v13; the UI since v0.18.0) ────────────── */

  /** Claims this device's voter for the room, after every join and reconnect. The key is never shown or logged. */
  private claimVoter(): void {
    const key = this.options.voterKey?.();
    if (key) this.send({ type: "claimVoter", key });
  }

  /**
   * The voting state from the relay (joined, votingChanged). A new round, or voting cleared,
   * empties my votes and the results; results are kept only while closed.
   */
  private votingFrom(voting: VotingState): Pick<RoomView, "voting" | "results" | "myVotes" | "remaining"> {
    const previous = this.view.voting;
    if (voting.round !== previous.round || voting.state === "off") {
      this.votesConfirmed.clear();
      this.votesPending.clear();
      this.votesLeft = voting.budget;
    }
    const results = voting.state === "closed" && voting.round === previous.round && previous.state === "closed" ? this.view.results : null;
    // Set first so voteView counts against the new budget.
    this.view = { ...this.view, voting };
    return { voting, results, ...this.voteView() };
  }

  /** My votes as shown (the relay's, with mine still waiting on top) and dots left. */
  private voteView(): Pick<RoomView, "myVotes" | "remaining"> {
    const shown = new Map(this.votesConfirmed);
    for (const [noteId, counts] of this.votesPending) {
      const count = counts.at(-1) ?? 0;
      if (count > 0) shown.set(noteId, count);
      else shown.delete(noteId);
    }
    const remaining = Math.max(0, Math.min(this.view.voting.budget, this.votesLeft - (sumVotes(shown) - sumVotes(this.votesConfirmed))));
    return { myVotes: shown, remaining };
  }

  private shiftPendingVote(noteId: string): void {
    const pending = this.votesPending.get(noteId);
    pending?.shift();
    if (pending?.length === 0) this.votesPending.delete(noteId);
  }

  /** A vote refused by the relay: rolled back (the oldest waiting one on that note), with one notice. */
  private voteRefused(noteId: string, code: string): void {
    this.shiftPendingVote(noteId);
    if (code === "voters_full") this.votersFull = true;
    const noteNotice =
      code === "over_budget"
        ? NOTICES.overBudget
        : code === "voting_closed"
          ? NOTICES.votingClosed
          : code === "voters_full"
            ? NOTICES.votersFull
            : code === "rate_limited"
              ? NOTICES.tooQuick
              : NOTICES.noVoter;
    this.update({ ...this.voteView(), noteNotice, votersFull: this.votersFull, ...(code === "rate_limited" ? { rateLimited: true } : {}) });
  }

  /**
   * Notes that are gone drop out of my votes (the relay refunds the dots) and of the results.
   * Only once the board is live: before the snapshot (or a reconnect's resync) it isn't the room's.
   */
  private pruneVotes(): void {
    if (!this.view.synced || this.resyncing || this.view.status !== "joined") return;
    const board = this.view.board;
    const here = (id: string) => findNote(board, id) !== undefined || board.removed.some((n) => n.note.id === id);
    let changed = false;
    for (const [id, count] of this.votesConfirmed) {
      if (here(id)) continue;
      this.votesConfirmed.delete(id);
      this.votesLeft += count;
      changed = true;
    }
    for (const id of this.votesPending.keys()) {
      if (here(id)) continue;
      this.votesPending.delete(id);
      changed = true;
    }
    const results = this.view.results?.filter((r) => here(r.noteId)) ?? null;
    if (results && results.length !== this.view.results?.length) changed = true;
    if (changed) this.update({ ...this.voteView(), results });
  }

  /**
   * Puts `count` of my dots on a note (0 takes them off). Optimistic: shown at once, rolled back
   * if the relay refuses (one notice). Refused here, with a notice and nothing sent, while
   * disconnected, when voting isn't open, without a voter, or over my dots. Not recorded by undo.
   */
  voteSet(noteId: string, count: number): boolean {
    if (!Number.isInteger(count) || count < 0 || count > VOTE_BUDGET_MAX) return false;
    if (!this.live) {
      this.update({ noteNotice: NOTICES.voteOffline });
      return false;
    }
    if (this.view.voting.state !== "open") {
      this.update({ noteNotice: NOTICES.votingClosed });
      return false;
    }
    if (!this.view.isVoter) {
      this.update({ noteNotice: this.votersFull ? NOTICES.votersFull : NOTICES.noVoter });
      return false;
    }
    if (!findNote(this.view.board, noteId)?.confirmed) return false;
    const shown = this.view.myVotes;
    if ((shown.get(noteId) ?? 0) === count) return true;
    if (sumVotes(shown) - (shown.get(noteId) ?? 0) + count > this.view.voting.budget) {
      this.update({ noteNotice: NOTICES.overBudget });
      return false;
    }
    this.votesPending.set(noteId, [...(this.votesPending.get(noteId) ?? []), count]);
    // Shown first: a refusal can only come after.
    this.update({ ...this.voteView(), noteNotice: null });
    this.send({ type: "voteSet", noteId, count });
    return true;
  }

  /** Host: starts a new round (every earlier vote goes). False (nothing sent) for a bad budget, a guest or while disconnected. */
  startVote(budget: number): boolean {
    if (!this.canHost() || this.running() || !Number.isInteger(budget) || budget < VOTE_BUDGET_MIN || budget > VOTE_BUDGET_MAX) return false;
    this.send({ type: "voteStart", budget });
    return true;
  }

  /** Host: closes the round; everyone gets the totals. Not while a run is going (as End session). */
  stopVote(): boolean {
    if (!this.canHost() || this.running()) return false;
    this.send({ type: "voteStop" });
    return true;
  }

  /** Host: deletes every vote and turns voting off. Not while a run is going. */
  clearVotes(): boolean {
    if (!this.canHost() || this.running()) return false;
    this.send({ type: "voteClear" });
    return true;
  }

  /** A final state: report it and close the socket. */
  private finish(status: RoomStatus): void {
    clearTimeout(this.timer);
    this.stopRetry();
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
    if (patch.noteNotice === null && !("dropReport" in patch)) patch = { ...patch, dropReport: null };
    const restore = this.restoreRun;
    this.view = {
      ...this.view,
      ...patch,
      adding: this.itemBatches.size > 0,
      clearing: this.clearRun?.kind === "clear",
      deleting: this.clearRun?.kind === "delete",
      reconnect: this.retryView(),
      ...(restore ? { historyReport: { text: UNDO_TEXT.restoring(restoredCount(restore), restore.refs.length), partial: false } } : {}),
    };
    this.view = { ...this.view, history: this.historyReasons() };
    this.armExpiry();
    this.options.onChange(this.view);
  }

  /**
   * A change waiting for the relay is given up on after EXPECT_TIMEOUT_MS, which can make undo
   * or redo possible again: a timer refreshes their reasons then, even with nothing else happening.
   */
  private armExpiry(): void {
    const at = this.stopped ? null : this.history.nextExpiry();
    if (at === this.expiryAt) return;
    clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
    this.expiryAt = at;
    if (at === null) return;
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = undefined;
      this.expiryAt = null;
      this.refreshHistory();
      this.armExpiry();
    }, Math.max(0, at - Date.now()));
  }
}
