import { DurableObject } from "cloudflare:workers";
import {
  FRAME_DEFAULTS,
  FRAME_DEFAULT_H,
  FRAME_DEFAULT_W,
  FRAME_EDIT_FIELDS,
  FRAME_STYLE_FIELDS,
  MAX_BATCH_ENTRIES,
  MAX_FRAMES_PER_ROOM,
  MAX_NOTES_PER_ROOM,
  MAX_PARTICIPANTS,
  MAX_SEALED_PER_WRITER,
  MAX_SHAPES_PER_ROOM,
  REVEAL_CHUNK_NOTES,
  SERVER_MESSAGES,
  SHAPE_EDIT_FIELDS,
  SHAPE_STYLE_FIELDS,
  MAX_VOTERS_PER_ROUND,
  NOTE_DEFAULTS,
  NOTE_EDIT_FIELDS,
  BOARD_WRITES,
  PROTOCOL_VERSION,
  ROOM_ENDED_CLOSE_CODE,
  ROOM_EXPIRED_CLOSE_CODE,
  VOTE_BUDGET_DEFAULT,
  VOTE_BUDGET_MAX,
  VOTE_BUDGET_MIN,
  VOTING_STATES,
  clampCursor,
  clampFramePosition,
  clampFrameRect,
  clampNotePosition,
  checkBatch,
  checkItems,
  checkOrder,
  clampNoteRect,
  clampShapePosition,
  clampShapeRect,
  checkShapeBatch,
  clientMessageSchema,
  cleanFrameTitle,
  cleanName,
  cleanNoteText,
  cleanShapeText,
  cleanText,
  encodeMessage,
  groupOffset,
  parseMessage,
  participantSchema,
  restack,
  shapeDefaults,
  zForNew,
  type ClientMessage,
  type ErrorCode,
  type Frame,
  type ItemRefusal,
  type Note,
  type NoteBatchResult,
  type Participant,
  type ServerMessage,
  type Shape,
  type ShapeBatchResult,
  type SilentState,
  type Stacked,
  type TimerState,
  type VotingState,
} from "@stickyard/shared";
import { z } from "zod";
import { randomBase64url } from "./crypto";
import type { Secrets } from "./env";
import { ENDED_REASON, EXPIRED_REASON, clearToTombstone, nextExpiryAlarm, readTombstone, writeTombstone, type Tombstone, type TombstoneKind } from "./expiry";
import { verifyHostToken } from "./hostToken";
import { BATCH_LIMITS, CURSOR_LIMITS, SOCKET_LIMITS } from "./limits";
import { NoteStore } from "./noteStore";
import { canSee, scrubFor } from "./sealed";
import { voterIdFor } from "./voterId";
import { writerIdFor } from "./writerId";

/**
 * Per-socket state, kept in the WebSocket attachment so it survives hibernation.
 * Notes and frames live in the room's SQLite (see noteStore.ts); nothing about people is stored.
 */
/**
 * The header the Worker sets (replacing any the client sent) to tell the room its id, which
 * claimHost needs to check a host token. Never read from anywhere else.
 */
export const ROOM_ID_HEADER = "x-stickyard-room-id";

const socketStateSchema = z.object({
  /** Said hello with our protocol version. */
  hello: z.boolean(),
  /**
   * Set once joined. Server-assigned; never taken from a message. `host` is set only by a verified
   * claimHost (protocol v12); it defaults to false for attachments from before v12.
   */
  participant: participantSchema.extend({ host: z.boolean().default(false) }).nullable(),
  /** The room id, from the Worker (ROOM_ID_HEADER). "" for sockets from before v12: they can't claim host. */
  roomId: z.string().default(""),
  /** Token bucket. */
  tokens: z.number(),
  at: z.number(),
  /** Over-limit messages since `strikeAt` (the start of the current violation window). */
  strikes: z.number().int(),
  strikeAt: z.number(),
  /**
   * The voter this socket votes as (protocol v13): an HMAC of the key it claimed with, set only by
   * claimVoter. Never the key itself, and never sent anywhere.
   */
  voterId: z.string().nullable().default(null),
  /**
   * The writer this socket adds and sees sealed notes as (protocol v17): an HMAC of the client key
   * its join carried (writerId.ts), set before the snapshot. Never the key, and never sent anywhere.
   * Kept here, so it survives hibernation; null without a key (no notes during a silent round).
   */
  writerId: z.string().nullable().default(null),
  /** Batch entries token bucket (BATCH_LIMITS). Defaults keep sockets from before v7 readable. */
  entryTokens: z.number().default(BATCH_LIMITS.entriesBurst),
  entryAt: z.number().default(0),
  /** Live cursor token bucket (CURSOR_LIMITS, protocol v14), and silent drops since `cursorDropAt`. */
  cursorTokens: z.number().default(CURSOR_LIMITS.burst),
  cursorAt: z.number().default(0),
  cursorDrops: z.number().int().default(0),
  cursorDropAt: z.number().default(0),
  /** The others have been sent this socket's cursor and not told it has gone (so cursorGone is owed). */
  cursorShown: z.boolean().default(false),
});
type SocketState = z.infer<typeof socketStateSchema>;

/** Which note, frame or shape (or pending add) an error is about, so the sender can roll back. */
type ErrorRef =
  | { clientRef: string }
  | { noteId: string }
  | { noteIds: string[] }
  | { shapeId: string }
  | { shapeIds: string[] }
  | { frameId: string; noteIds?: string[]; shapeIds?: string[] }
  | Record<string, never>;

const error = (code: ErrorCode, message: string, ref: ErrorRef = {}): ServerMessage => ({ type: "error", code, message, ...ref });

function refOf(message: ClientMessage): ErrorRef {
  switch (message.type) {
    case "noteAdd":
      return { clientRef: message.clientRef };
    case "noteEdit":
    case "noteMove":
    case "noteResize":
    case "noteDelete":
      return { noteId: message.id };
    case "noteBatch": {
      // Every note the batch names (readable ids only), so the sender rolls them all back.
      const { valid, invalidIds } = checkBatch(message.ops);
      const noteIds = [...new Set([...valid.map((v) => v.entry.id), ...invalidIds])];
      return noteIds.length > 0 ? { noteIds } : {};
    }
    case "notesOrder": {
      const { valid, invalidIds } = checkOrder(message.ids);
      const noteIds = [...new Set([...valid.map((v) => v.id), ...invalidIds])];
      return noteIds.length > 0 ? { noteIds } : {};
    }
    case "frameAdd":
    case "itemsAdd":
    case "shapeAdd":
      return { clientRef: message.clientRef };
    case "shapeEdit":
    case "shapeMove":
    case "shapeResize":
    case "shapeDelete":
      return { shapeId: message.id };
    case "shapeBatch": {
      const { valid, invalidIds } = checkShapeBatch(message.ops);
      const shapeIds = [...new Set([...valid.map((v) => v.entry.id), ...invalidIds])];
      return shapeIds.length > 0 ? { shapeIds } : {};
    }
    case "frameEdit":
    case "frameResize":
    case "frameDelete":
      return { frameId: message.id };
    case "voteSet":
      return { noteId: message.noteId };
    case "frameMove":
      // The notes and shapes it was carrying roll back with it.
      return {
        frameId: message.id,
        ...(message.noteIds && message.noteIds.length > 0 ? { noteIds: message.noteIds } : {}),
        ...(message.shapeIds && message.shapeIds.length > 0 ? { shapeIds: message.shapeIds } : {}),
      };
    default:
      return {};
  }
}

type NoteMessage = Extract<ClientMessage, { type: "noteAdd" | "noteEdit" | "noteMove" | "noteResize" | "noteDelete" }>;
type BatchMessage = Extract<ClientMessage, { type: "noteBatch" }>;
type OrderMessage = Extract<ClientMessage, { type: "notesOrder" }>;
type FrameMessage = Extract<ClientMessage, { type: "frameAdd" | "frameEdit" | "frameMove" | "frameResize" | "frameDelete" }>;
type ItemsMessage = Extract<ClientMessage, { type: "itemsAdd" }>;
type ShapeMessage = Extract<ClientMessage, { type: "shapeAdd" | "shapeEdit" | "shapeMove" | "shapeResize" | "shapeDelete" }>;
type ShapeBatchMessage = Extract<ClientMessage, { type: "shapeBatch" }>;
type VotingHostMessage = Extract<ClientMessage, { type: "voteStart" | "voteStop" | "voteClear" }>;
type CursorMessage = Extract<ClientMessage, { type: "cursor" | "cursorLeft" }>;
type JoinMessage = Extract<ClientMessage, { type: "join" }>;
type SilentMessage = Extract<ClientMessage, { type: "silentStart" | "silentReveal" }>;

/** The silent round's meta keys (protocol v17): 1 while a round runs, and rounds started. */
const SILENT_KEYS = { active: "silent_active", round: "silent_round" } as const;
const isCursor = (message: ClientMessage): message is CursorMessage => message.type === "cursor" || message.type === "cursorLeft";

/** The voting state's meta keys and their stored values (state as its index in VOTING_STATES). */
const VOTING_KEYS = { state: "voting_state", budget: "voting_budget", round: "voting_round" } as const;
const VOTING_OFF: VotingState = { state: "off", budget: VOTE_BUDGET_DEFAULT, round: 0 };

/** The voting state from meta values; anything missing or out of range takes its default. */
function readVoting(get: (key: string) => number | null): VotingState {
  const state = VOTING_STATES[get(VOTING_KEYS.state) ?? 0] ?? "off";
  const budget = get(VOTING_KEYS.budget);
  const round = get(VOTING_KEYS.round);
  return {
    state,
    budget: budget !== null && Number.isInteger(budget) && budget >= VOTE_BUDGET_MIN && budget <= VOTE_BUDGET_MAX ? budget : VOTE_BUDGET_DEFAULT,
    round: round !== null && Number.isSafeInteger(round) && round >= 0 ? round : 0,
  };
}

/** Drags and resizes in progress (a note, a group or a frame): relayed (coalesced), never stored. */
const isPreview = (message: ClientMessage) =>
  (message.type === "noteMove" ||
    message.type === "noteResize" ||
    message.type === "noteBatch" ||
    message.type === "frameMove" ||
    message.type === "frameResize" ||
    message.type === "shapeMove" ||
    message.type === "shapeResize" ||
    message.type === "shapeBatch") &&
  !message.final;

/** A frame's live move or resize waiting to be relayed (latest per frame and kind). */
interface PendingFrame {
  from: WebSocket;
  message: Extract<ServerMessage, { type: "frameMoved" | "frameResized" }>;
}

/** A shape's live move or resize waiting to be relayed. `batch`: it came in a shapeBatch (goes out in a shapesBatchApplied). */
interface PendingShape {
  from: WebSocket;
  message: Extract<ServerMessage, { type: "shapeMoved" | "shapeResized" }>;
  batch: boolean;
}

/** A relayed change waiting to go out. `batch`: it came in a noteBatch, so it goes out in a notesBatchApplied. */
interface Pending {
  from: WebSocket;
  message: Extract<ServerMessage, { type: "noteMoved" | "noteResized" }>;
  batch: boolean;
}

/**
 * One instance per room, addressed by the room id from a verified code.
 * Uses the WebSocket Hibernation API so idle rooms don't stay in memory. The participant
 * list is derived from the live sockets' attachments. Idle rooms expire (expiry.ts): the last
 * socket to close sets the alarm, and `alarm` deletes the room and leaves a tombstone.
 */
export class Room extends DurableObject<Env> {
  /** The notes and frames; null once the room has expired or ended (nothing may read or write them). */
  private store: NoteStore | null;
  /** Why and when the room went (expired or ended), or null while it is alive. */
  private tombstone: Tombstone | null;
  /** The board lock (protocol v12), from meta. */
  private locked = false;
  /** The timer (protocol v12), from meta: start by the server's clock, and length. */
  private timer: { startedAt: number; durationMs: number } | null = null;
  /** Dot voting (protocol v13), from meta. */
  private voting: VotingState = VOTING_OFF;
  /** Silent brainstorm (protocol v17), from meta: a round is running, and rounds started. */
  private silent = { active: false, round: 0 };
  /** Rows written outside the current store: alarm sets, tombstones, and a store dropped at burial. */
  private otherRows = 0;
  /** Non-final moves and resizes waiting to be relayed, latest per note and kind. Never stored. */
  private readonly pendingMoves = new Map<string, Pending>();
  /** Frames' live moves and resizes, likewise. */
  private readonly pendingFrames = new Map<string, PendingFrame>();
  /** Shapes' live moves and resizes, likewise. */
  private readonly pendingShapes = new Map<string, PendingShape>();
  private flushScheduled = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // An expired or ended room never runs the normal init: that would create a fresh board under the tombstone.
    this.tombstone = readTombstone(ctx.storage.sql);
    this.store = this.tombstone === null ? new NoteStore(ctx.storage.sql, (fn) => ctx.storage.transactionSync(fn)) : null;
    if (this.store) {
      this.locked = this.store.getMeta("locked") === 1;
      const startedAt = this.store.getMeta("timer_started_at");
      const durationMs = this.store.getMeta("timer_duration_ms");
      this.timer = startedAt !== null && durationMs !== null ? { startedAt, durationMs } : null;
      this.voting = readVoting((key) => this.store?.getMeta(key) ?? null);
      const round = this.store.getMeta(SILENT_KEYS.round);
      this.silent = { active: this.store.getMeta(SILENT_KEYS.active) === 1, round: round !== null && Number.isSafeInteger(round) && round >= 0 ? round : 0 };
    }
  }

  /** Only reached from joined sockets, which a buried room never has (see fetch and webSocketMessage). */
  private get notes(): NoteStore {
    if (!this.store) throw new Error("room gone");
    return this.store;
  }

  /** The timer as sent: with the server's clock now, so pages can work out their offset. */
  private timerView(): TimerState | null {
    return this.timer ? { ...this.timer, serverNow: Date.now() } : null;
  }

  /**
   * Rows written by this instance (tests check drags write nothing). Counts an alarm set as one
   * row, as Cloudflare bills it.
   */
  get rowsWritten(): number {
    return this.otherRows + (this.store?.rowsWritten ?? 0);
  }

  /** The room has expired (an expired_at tombstone). */
  get expired(): boolean {
    return this.tombstone?.kind === "expired";
  }

  /** A host ended the room (an ended_at tombstone). */
  get ended(): boolean {
    return this.tombstone?.kind === "ended";
  }

  /** A relay of coalesced moves is waiting on a timer (tests check cursors schedule nothing). */
  get timersPending(): boolean {
    return this.flushScheduled;
  }

  /** Batch transactions committed by this instance (tests check a final batch is one). */
  get transactions(): number {
    return this.store?.transactions ?? 0;
  }

  override async fetch(request: Request): Promise<Response> {
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    if (this.tombstone !== null) {
      // Room links stay validly signed, so this close is how a visitor learns the room has gone.
      this.closeGone(pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    const state: SocketState = {
      hello: false,
      participant: null,
      roomId: request.headers.get(ROOM_ID_HEADER) ?? "",
      voterId: null,
      writerId: null,
      tokens: SOCKET_LIMITS.burst,
      at: Date.now(),
      strikes: 0,
      strikeAt: 0,
      entryTokens: BATCH_LIMITS.entriesBurst,
      entryAt: Date.now(),
      cursorTokens: CURSOR_LIMITS.burst,
      cursorAt: Date.now(),
      cursorDrops: 0,
      cursorDropAt: 0,
      cursorShown: false,
    };
    pair[1].serializeAttachment(state);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /** Closes a socket to a buried room with its code: 4410 expired, 4411 ended. */
  private closeGone(ws: WebSocket): void {
    if (this.tombstone?.kind === "ended") safeClose(ws, ROOM_ENDED_CLOSE_CODE, ENDED_REASON);
    else safeClose(ws, ROOM_EXPIRED_CLOSE_CODE, EXPIRED_REASON);
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (this.tombstone !== null) {
      this.closeGone(ws);
      return;
    }
    const state = readState(ws);
    if (!state) {
      ws.close(1011, "error");
      return;
    }

    // Every frame, valid or not, spends from a rate budget before it is acted on. A valid cursor
    // message (protocol v14) spends its own (CURSOR_LIMITS); everything else, malformed messages
    // included, spends SOCKET_LIMITS. Parsing comes first so cursors never spend edits' tokens.
    const now = Date.now();
    const parsed = parseMessage(message, clientMessageSchema);
    if (parsed.ok && isCursor(parsed.value)) return this.cursor(ws, state, now, parsed.value);
    state.tokens = Math.min(SOCKET_LIMITS.burst, state.tokens + ((now - state.at) / 1000) * SOCKET_LIMITS.refillPerSecond);
    state.at = now;
    if (state.tokens < 1) {
      // The message is dropped. Name the note it was about (if any) so the sender can roll back.
      await this.overLimit(ws, state, now, parsed.ok ? refOf(parsed.value) : {});
      return;
    }
    state.tokens -= 1;

    if (!parsed.ok) {
      ws.serializeAttachment(state);
      this.send(
        ws,
        parsed.error === "too_large"
          ? error("too_large", "Message is too large.")
          : error("bad_message", "Message could not be understood."),
      );
      return;
    }
    const entries = entriesOf(parsed.value);
    if (entries > 0) {
      // A batch, a restack or a carrying frame move is one message above; its entries also spend their own budget.
      state.entryTokens = Math.min(BATCH_LIMITS.entriesBurst, state.entryTokens + ((now - state.entryAt) / 1000) * BATCH_LIMITS.entriesPerSecond);
      state.entryAt = now;
      if (state.entryTokens < entries) {
        await this.overLimit(ws, state, now, refOf(parsed.value));
        return;
      }
      state.entryTokens -= entries;
    }
    await this.handle(ws, state, parsed.value);
  }

  /** A message over a rate budget is dropped with rate_limited (naming its notes), as a violation. */
  private async overLimit(ws: WebSocket, state: SocketState, now: number, ref: ErrorRef): Promise<void> {
    await this.violation(ws, state, now, error("rate_limited", "Slow down a little.", ref));
  }

  /**
   * A live cursor (protocol v14): forwarded at once to the other joined sockets as cursorMoved /
   * cursorGone, with this socket's participant id. Never stored, never coalesced, nothing
   * scheduled. Over CURSOR_LIMITS it is dropped silently; only drops past maxSilentDrops in a
   * window count as violations. Before joining, or alone in the room, nothing is sent.
   */
  private async cursor(ws: WebSocket, state: SocketState, now: number, message: CursorMessage): Promise<void> {
    state.cursorTokens = Math.min(CURSOR_LIMITS.burst, state.cursorTokens + ((now - state.cursorAt) / 1000) * CURSOR_LIMITS.refillPerSecond);
    state.cursorAt = now;
    if (state.cursorTokens < 1) {
      if (now - state.cursorDropAt > CURSOR_LIMITS.dropWindowMs) {
        state.cursorDrops = 0;
        state.cursorDropAt = now;
      }
      state.cursorDrops += 1;
      if (state.cursorDrops > CURSOR_LIMITS.maxSilentDrops) return this.violation(ws, state, now, null);
      ws.serializeAttachment(state);
      return;
    }
    state.cursorTokens -= 1;
    const you = state.participant;
    const others = you ? this.participants().filter((p) => p.ws !== ws) : [];
    const shown = state.cursorShown;
    state.cursorShown = you !== null && others.length > 0 && message.type === "cursor";
    ws.serializeAttachment(state);
    if (!you || others.length === 0) return;
    if (message.type === "cursorLeft" && !shown) return;
    const out: ServerMessage = message.type === "cursor" ? { type: "cursorMoved", id: you.id, ...clampCursor(message.x, message.y) } : { type: "cursorGone", id: you.id };
    const raw = encodeMessage(out);
    for (const other of others) sendRaw(other.ws, raw);
  }

  /**
   * A violation (over a rate budget, or a wrong host token): answered with `reply` (cursor drops
   * get none), and counted. Violations are counted per window, not consecutively, so a sender at
   * twice the rate still gets closed.
   */
  private async violation(ws: WebSocket, state: SocketState, now: number, reply: ServerMessage | null): Promise<void> {
    if (now - state.strikeAt > SOCKET_LIMITS.violationWindowMs) {
      state.strikes = 0;
      state.strikeAt = now;
    }
    state.strikes += 1;
    if (state.strikes >= SOCKET_LIMITS.maxViolations) {
      this.leave(ws, state);
      safeClose(ws, 1008, "Too many messages");
      await this.armExpiry(ws);
      return;
    }
    ws.serializeAttachment(state);
    if (reply) this.send(ws, reply);
  }

  override async webSocketClose(ws: WebSocket, code: number, _reason: string, _wasClean: boolean): Promise<void> {
    const state = readState(ws);
    if (state) this.leave(ws, state);
    // 1005/1006 are reserved and cannot be sent back in a close frame.
    safeClose(ws, code === 1005 || code === 1006 ? 1000 : code, "closing");
    await this.armExpiry(ws);
  }

  override async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    const state = readState(ws);
    if (state) this.leave(ws, state);
    safeClose(ws, 1011, "error");
    await this.armExpiry(ws);
  }

  /**
   * `closing` has gone. If it was the last open socket, make sure the room's alarm is about
   * ROOM_IDLE_EXPIRY_MS away: one write, and none at all when the alarm already is within
   * ALARM_RESET_SLACK_MS of that (nextExpiryAlarm). Joining never touches the alarm.
   */
  private async armExpiry(closing: WebSocket): Promise<void> {
    if (this.tombstone !== null) return;
    if (this.openSockets(closing) > 0) return;
    const at = nextExpiryAlarm(await this.ctx.storage.getAlarm(), Date.now());
    if (at === null) return;
    await this.ctx.storage.setAlarm(at);
    this.otherRows += 1;
  }

  /** Open sockets, leaving out `except`. Hibernated sockets count: they are still connected. */
  private openSockets(except?: WebSocket): number {
    return this.ctx.getWebSockets().filter((ws) => ws !== except && ws.readyState === WebSocket.OPEN).length;
  }

  /**
   * The expiry alarm. With anyone connected (joined or not), nothing happens and nothing is
   * written; the next last close sets a new alarm. Otherwise the room is buried as expired.
   * Already buried (expired or ended): nothing to do.
   */
  override async alarm(): Promise<void> {
    if (this.tombstone !== null || this.openSockets() > 0) return;
    const at = this.buryNow("expired");
    await this.finishBurial(at);
  }

  /**
   * Burial, step 1 (synchronous, see expiry.ts): in one transaction every table but meta is
   * dropped, meta emptied and the tombstone written; then the in-memory state goes, so this
   * instance can't serve old notes or settings. From here every socket message and every new
   * socket is closed with the tombstone's code. Returns the tombstone.
   */
  private buryNow(kind: TombstoneKind): Tombstone {
    const tombstone: Tombstone = { kind, at: Date.now() };
    let rows = 0;
    this.ctx.storage.transactionSync(() => {
      rows = clearToTombstone(this.ctx.storage.sql, tombstone);
    });
    this.otherRows += rows + (this.store?.rowsWritten ?? 0);
    this.store = null;
    this.tombstone = tombstone;
    this.locked = false;
    this.timer = null;
    this.voting = VOTING_OFF;
    this.silent = { active: false, round: 0 };
    this.pendingMoves.clear();
    this.pendingFrames.clear();
    this.pendingShapes.clear();
    return tombstone;
  }

  /** Burial, steps 2 and 3: deleteAll() for everything else (it removes the tombstone too), then the tombstone again. */
  private async finishBurial(tombstone: Tombstone): Promise<void> {
    await this.ctx.storage.deleteAll();
    this.otherRows += writeTombstone(this.ctx.storage.sql, tombstone);
  }

  private async handle(ws: WebSocket, state: SocketState, message: ClientMessage): Promise<void> {
    // Anything other than a drag or resize in progress relays pending ones first, so everyone
    // sees changes in arrival order.
    if (!isPreview(message)) this.flushMoves();
    // Sealed notes deleted by the last message are no longer needed by the outbound filter.
    this.store?.forgetGone();

    // A locked board refuses a non-host's changes (protocol v12): nothing written or relayed, and
    // the refusal names what to roll back. BOARD_WRITES classifies every message type.
    if (BOARD_WRITES[message.type] && this.locked && state.participant && !state.participant.host) {
      ws.serializeAttachment(state);
      return this.send(ws, error("board_locked", "The host has locked the board.", refOf(message)));
    }
    // A silent round (protocol v17) refuses frame moves for everyone: a frame would carry notes
    // other people can't see. Nothing written or relayed; the refusal names what to roll back.
    if (message.type === "frameMove" && this.silent.active && state.participant) {
      ws.serializeAttachment(state);
      return this.send(ws, error("silent_active", "Frames can't be moved during a silent round.", refOf(message)));
    }
    const viewer = state.writerId;

    switch (message.type) {
      case "hello": {
        if (message.protocolVersion !== PROTOCOL_VERSION) {
          ws.serializeAttachment(state);
          this.send(ws, error("version_mismatch", `Server speaks protocol v${PROTOCOL_VERSION}. Please reload.`));
          return;
        }
        state.hello = true;
        ws.serializeAttachment(state);
        this.send(ws, { type: "welcome", protocolVersion: PROTOCOL_VERSION });
        return;
      }

      case "join":
        return this.join(ws, state, message);

      case "say": {
        ws.serializeAttachment(state);
        if (!state.participant) return this.send(ws, error("not_joined", "Join the room first."));
        const text = cleanText(message.text);
        if (text === null) return this.send(ws, error("bad_message", "Messages need 1 to 280 visible characters."));
        // The sender comes from this socket's server-set identity, never from the message.
        this.broadcast({ type: "echo", from: state.participant.id, text });
        return;
      }

      case "noteAdd":
      case "noteEdit":
      case "noteMove":
      case "noteResize":
      case "noteDelete": {
        ws.serializeAttachment(state);
        if (!state.participant) return this.send(ws, error("not_joined", "Join the room first.", refOf(message)));
        this.handleNote(ws, state.participant, viewer, message);
        return;
      }

      case "noteBatch": {
        ws.serializeAttachment(state);
        if (!state.participant) return this.send(ws, error("not_joined", "Join the room first.", refOf(message)));
        this.handleBatch(ws, viewer, message);
        return;
      }

      case "notesOrder": {
        ws.serializeAttachment(state);
        if (!state.participant) return this.send(ws, error("not_joined", "Join the room first.", refOf(message)));
        this.handleOrder(ws, viewer, message);
        return;
      }

      case "frameAdd":
      case "frameEdit":
      case "frameMove":
      case "frameResize":
      case "frameDelete": {
        ws.serializeAttachment(state);
        if (!state.participant) return this.send(ws, error("not_joined", "Join the room first.", refOf(message)));
        this.handleFrame(ws, state.participant, viewer, message);
        return;
      }

      case "shapeAdd":
      case "shapeEdit":
      case "shapeMove":
      case "shapeResize":
      case "shapeDelete": {
        ws.serializeAttachment(state);
        if (!state.participant) return this.send(ws, error("not_joined", "Join the room first.", refOf(message)));
        this.handleShape(ws, state.participant, message);
        return;
      }

      case "shapeBatch": {
        ws.serializeAttachment(state);
        if (!state.participant) return this.send(ws, error("not_joined", "Join the room first.", refOf(message)));
        this.handleShapeBatch(ws, message);
        return;
      }

      case "itemsAdd": {
        ws.serializeAttachment(state);
        if (!state.participant) return this.send(ws, error("not_joined", "Join the room first.", refOf(message)));
        this.handleItems(ws, state.participant, viewer, message);
        return;
      }

      case "claimHost":
        return this.claimHost(ws, state, message.token);

      case "claimVoter":
        return this.claimVoter(ws, state, message.key);

      case "voteSet": {
        ws.serializeAttachment(state);
        if (!state.participant) return this.send(ws, error("not_joined", "Join the room first.", refOf(message)));
        return this.voteSet(ws, state, message.noteId, message.count);
      }

      case "voteStart":
      case "voteStop":
      case "voteClear": {
        ws.serializeAttachment(state);
        if (!state.participant) return this.send(ws, error("not_joined", "Join the room first."));
        if (!state.participant.host) return this.send(ws, error("not_host", "Only the host can do that."));
        // A vote during a silent round would only count the notes everyone can see (protocol v17).
        if (message.type === "voteStart" && this.silent.active) return this.send(ws, error("silent_active", "Voting can't start during a silent round."));
        return this.handleVoting(ws, message);
      }

      case "silentStart":
      case "silentReveal": {
        ws.serializeAttachment(state);
        if (!state.participant) return this.send(ws, error("not_joined", "Join the room first."));
        if (!state.participant.host) return this.send(ws, error("not_host", "Only the host can do that."));
        return this.handleSilent(ws, message);
      }

      case "lockSet":
      case "timerStart":
      case "timerStop":
      case "endSession": {
        ws.serializeAttachment(state);
        if (!state.participant) return this.send(ws, error("not_joined", "Join the room first."));
        if (!state.participant.host) return this.send(ws, error("not_host", "Only the host can do that."));
        return this.handleHost(ws, message);
      }
    }
  }

  /**
   * join: a participant with a server-assigned id and colour, then (in one step, so nothing can land
   * between them) joined with the room's lock, timer, voting and silent state, and the notes,
   * frames and shapes snapshots. Since v17 a join may carry the page's client key: its writer id
   * (writerId.ts) is worked out first, so the snapshot already holds that writer's sealed notes on
   * every join, reconnect and second tab, and nobody else's. The key is never stored or echoed.
   */
  private async join(ws: WebSocket, state: SocketState, message: JoinMessage): Promise<void> {
    ws.serializeAttachment(state);
    if (!state.hello) return this.send(ws, error("bad_message", "Say hello first."));
    if (state.participant) return this.send(ws, error("already_joined", "Already joined."));
    const name = cleanName(message.name);
    if (name === null) return this.send(ws, error("invalid_name", "Names need 1 to 24 visible characters."));
    let latest = state;
    let writerId: string | null = null;
    if (message.key !== undefined) {
      writerId = await writerIdFor(state.roomId, message.key, (this.env as Env & Secrets).ROOM_SIGNING_KEY ?? "");
      // Other messages from this socket may have been handled while that was worked out: start from its latest state.
      latest = readState(ws) ?? state;
      if (this.tombstone !== null) return;
      if (latest.participant) return this.send(ws, error("already_joined", "Already joined."));
    }
    const others = this.participants();
    if (others.length >= MAX_PARTICIPANTS) return this.send(ws, error("room_full", "This room is full."));

    const used = new Set(others.map(({ participant }) => participant.colourIndex));
    let colourIndex = 0;
    while (used.has(colourIndex)) colourIndex++;
    const you: Participant = { id: randomBase64url(12), name, colourIndex, host: false };
    latest.participant = you;
    latest.writerId = writerId;
    ws.serializeAttachment(latest);

    // Lock, timer, voting and the silent round ride on joined, in this same step as the snapshots: nothing can land between them.
    this.send(ws, {
      type: "joined",
      you,
      participants: this.participants().map(({ participant }) => participant),
      locked: this.locked,
      timer: this.timerView(),
      voting: this.voting,
      silent: this.silentView(),
    });
    // Notes (only those this socket's writer may see: send filters), then frames, then shapes, in this same step.
    this.send(ws, { type: "snapshot", notes: this.notes.all() });
    this.send(ws, { type: "framesSnapshot", frames: this.notes.allFrames() });
    this.send(ws, { type: "shapesSnapshot", shapes: this.notes.allShapes() });
    // A closed round's totals, so a late joiner sees the results. While open, nothing about anyone's votes.
    if (this.voting.state === "closed") this.send(ws, this.revealed());
    this.broadcast({ type: "participant_joined", participant: you }, ws);
  }

  /** The silent round as sent: running or not, and one count of everyone's sealed notes. */
  private silentView(): SilentState {
    return { active: this.silent.active, count: this.store?.sealedCount ?? 0 };
  }

  /** Tells everyone the silent round's state and count (one small message, nothing about whose). */
  private broadcastSilent(): void {
    this.broadcast({ type: "silentChanged", ...this.silentView() });
  }

  /**
   * Host-only silent round messages (protocol v17). silentStart: a new round (meta silent_active 1
   * and the round + 1, one transaction); one already running is refused (silent_active). silentReveal:
   * every sealed note becomes a normal one (one row each, writer NULL, and the flag, in one
   * transaction), then everyone gets them in notesRevealed chunks of REVEAL_CHUNK_NOTES and the
   * new state last. Revealing with no round running writes nothing and answers only the sender.
   */
  private handleSilent(ws: WebSocket, message: SilentMessage): void {
    if (message.type === "silentStart") {
      if (this.silent.active) return this.send(ws, error("silent_active", "A silent round is already running."));
      const round = this.silent.round + 1;
      this.notes.setMeta({ [SILENT_KEYS.active]: 1, [SILENT_KEYS.round]: round });
      this.silent = { active: true, round };
      return this.broadcastSilent();
    }
    if (!this.silent.active) return this.send(ws, { type: "silentChanged", ...this.silentView() });
    const notes = this.notes.reveal({ [SILENT_KEYS.active]: 0 });
    this.silent = { ...this.silent, active: false };
    for (let i = 0; i < notes.length; i += REVEAL_CHUNK_NOTES) {
      this.broadcast({ type: "notesRevealed", notes: notes.slice(i, i + REVEAL_CHUNK_NOTES), final: i + REVEAL_CHUNK_NOTES >= notes.length });
    }
    this.broadcastSilent();
  }

  /** The note, if this writer may see it (protocol v17): someone else's sealed note is an unknown id. */
  private noteFor(viewer: string | null, id: string): Note | undefined {
    const note = this.notes.get(id);
    if (!note) return undefined;
    return canSee(this.notes.writerOf(id), viewer) ? note : undefined;
  }

  /**
   * claimHost (protocol v12): the token is checked against this room's id in constant time. Right:
   * the socket's participant becomes host (in its attachment, so it survives hibernation), it gets
   * hostGranted and the others get participantUpdated. Wrong: bad_host_token, counted as a
   * violation. The token is never stored, echoed or logged.
   */
  private async claimHost(ws: WebSocket, state: SocketState, token: string): Promise<void> {
    if (!state.participant) {
      ws.serializeAttachment(state);
      return this.send(ws, error("not_joined", "Join the room first."));
    }
    const ok = await verifyHostToken(token, state.roomId, (this.env as Env & Secrets).ROOM_SIGNING_KEY ?? "");
    // Other messages from this socket may have been handled while that was checked: start from its latest state.
    const latest = readState(ws) ?? state;
    if (!ok) return this.violation(ws, latest, Date.now(), error("bad_host_token", "That host key isn't valid for this session."));
    const participant = latest.participant;
    if (!participant) return;
    const already = participant.host;
    participant.host = true;
    ws.serializeAttachment(latest);
    this.send(ws, { type: "hostGranted" });
    if (!already) this.broadcast({ type: "participantUpdated", participant }, ws);
  }

  /**
   * claimVoter (protocol v13): the socket votes as HMAC(room id, key) from now on (kept in its
   * attachment, so it survives hibernation). The same key from another socket is the same voter.
   * At most MAX_VOTERS_PER_ROUND voters (with votes this round, or claimed on an open socket):
   * a new one beyond that gets voters_full. Writes nothing. The key is never stored, echoed or logged.
   */
  private async claimVoter(ws: WebSocket, state: SocketState, key: string): Promise<void> {
    if (!state.participant) {
      ws.serializeAttachment(state);
      return this.send(ws, error("not_joined", "Join the room first."));
    }
    ws.serializeAttachment(state);
    const voterId = await voterIdFor(state.roomId, key, (this.env as Env & Secrets).ROOM_SIGNING_KEY ?? "");
    // Other messages from this socket may have been handled while that was worked out: start from its latest state.
    const latest = readState(ws) ?? state;
    if (this.tombstone !== null || !latest.participant) return;
    if (voterId === null) return this.send(ws, error("bad_message", "Voting isn't available in this session."));
    const known = this.knownVoters(ws);
    if (!known.has(voterId) && known.size >= MAX_VOTERS_PER_ROUND) {
      return this.send(ws, error("voters_full", `This round has the maximum of ${MAX_VOTERS_PER_ROUND} voters.`));
    }
    latest.voterId = voterId;
    ws.serializeAttachment(latest);
    this.send(ws, { type: "voterGranted", remaining: this.remaining(voterId), mine: this.notes.votesOf(voterId) });
  }

  /** Voters this round: those with votes, and those claimed on other open sockets. */
  private knownVoters(except?: WebSocket): Set<string> {
    const known = this.notes.voterIds();
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except || ws.readyState !== WebSocket.OPEN) continue;
      const voterId = readState(ws)?.voterId;
      if (voterId) known.add(voterId);
    }
    return known;
  }

  /** Dots a voter has left this round. */
  private remaining(voterId: string): number {
    return Math.max(0, this.voting.budget - this.notes.usedBy(voterId));
  }

  /**
   * voteSet (protocol v13): only while open and after claimVoter. Unknown or deleted notes are
   * ignored silently. The voter's total must stay within the budget (over_budget otherwise).
   * Stored only when it changes; confirmed to the voter's own sockets either way, and to nobody
   * else (votes are anonymous and there are no live totals).
   */
  private voteSet(ws: WebSocket, state: SocketState, noteId: string, count: number): void {
    if (this.voting.state !== "open") return this.send(ws, error("voting_closed", "Voting isn't open.", { noteId }));
    const voterId = state.voterId;
    if (!voterId) return this.send(ws, error("no_voter", "Claim a voter first.", { noteId }));
    // Unknown, deleted and (protocol v17) sealed notes, anyone's: ignored. Votes are for notes everyone can see.
    if (!this.notes.get(noteId) || this.notes.writerOf(noteId) !== null) return;
    const mine = this.notes.votesOf(voterId);
    const others = mine.reduce((sum, v) => sum + (v.noteId === noteId ? 0 : v.count), 0);
    if (others + count > this.voting.budget) return this.send(ws, error("over_budget", "That's more dots than you have.", { noteId }));
    // A voter new to this round's votes (a backstop: claimVoter already counts them).
    if (count > 0 && mine.length === 0 && !this.notes.voterIds().has(voterId) && this.notes.voterIds().size >= MAX_VOTERS_PER_ROUND) {
      return this.send(ws, error("voters_full", `This round has the maximum of ${MAX_VOTERS_PER_ROUND} voters.`, { noteId }));
    }
    this.notes.setVote(voterId, noteId, count);
    const confirmed: ServerMessage = { type: "voteConfirmed", noteId, count, remaining: this.remaining(voterId) };
    for (const socket of this.ctx.getWebSockets()) {
      if (socket.readyState === WebSocket.OPEN && readState(socket)?.voterId === voterId) this.send(socket, confirmed);
    }
  }

  /** The round's totals, as sent. */
  private revealed(): ServerMessage {
    return { type: "votesRevealed", round: this.voting.round, totals: this.notes.totals() };
  }

  /**
   * Host-only voting messages (protocol v13). voteStart: a new round (every earlier vote deleted,
   * round + 1). voteStop: closed, then the totals to everyone. voteClear: every vote deleted, off.
   * Each writes only what changes; with nothing to change only the sender is answered.
   */
  private handleVoting(ws: WebSocket, message: VotingHostMessage): void {
    const current = this.voting;
    let next: VotingState;
    switch (message.type) {
      case "voteStart":
        next = { state: "open", budget: message.budget, round: current.round + 1 };
        break;
      case "voteStop":
        if (current.state !== "open") {
          this.send(ws, { type: "votingChanged", voting: current });
          if (current.state === "closed") this.send(ws, this.revealed());
          return;
        }
        next = { ...current, state: "closed" };
        break;
      case "voteClear":
        if (current.state === "off" && this.notes.voterIds().size === 0) return this.send(ws, { type: "votingChanged", voting: current });
        next = { ...current, state: "off" };
        break;
    }
    const changed: Record<string, number> = {};
    if (next.state !== current.state) changed[VOTING_KEYS.state] = VOTING_STATES.indexOf(next.state);
    if (next.budget !== current.budget) changed[VOTING_KEYS.budget] = next.budget;
    if (next.round !== current.round) changed[VOTING_KEYS.round] = next.round;
    this.notes.setVoting(changed, message.type !== "voteStop");
    this.voting = next;
    this.broadcast({ type: "votingChanged", voting: next });
    if (next.state === "closed") this.broadcast(this.revealed());
  }

  /** Host-only messages (protocol v12), from a host. Each writes only when something changes. */
  private async handleHost(ws: WebSocket, message: Extract<ClientMessage, { type: "lockSet" | "timerStart" | "timerStop" | "endSession" }>): Promise<void> {
    switch (message.type) {
      case "lockSet": {
        if (message.locked === this.locked) return this.send(ws, { type: "lockChanged", locked: this.locked });
        this.notes.setMeta({ locked: message.locked ? 1 : 0 });
        this.locked = message.locked;
        return this.broadcast({ type: "lockChanged", locked: this.locked });
      }
      case "timerStart": {
        // Starting while one runs replaces it. The server's clock, never the client's.
        const timer = { startedAt: Date.now(), durationMs: message.durationMs };
        this.notes.setMeta({ timer_started_at: timer.startedAt, timer_duration_ms: timer.durationMs });
        this.timer = timer;
        return this.broadcast({ type: "timerChanged", timer: this.timerView() });
      }
      case "timerStop": {
        if (!this.timer) return this.send(ws, { type: "timerChanged", timer: null });
        this.notes.setMeta({ timer_started_at: null, timer_duration_ms: null });
        this.timer = null;
        return this.broadcast({ type: "timerChanged", timer: null });
      }
      case "endSession": {
        // Everyone hears it, the room is buried (step 1 is synchronous, so nothing can be written
        // after it), every socket is closed with 4411, then the rest of the storage goes. Shown
        // cursors go first, so no page is left drawing one.
        for (const { ws: socket } of this.participants()) this.hideCursor(socket);
        this.broadcast({ type: "sessionEnded" });
        const tombstone = this.buryNow("ended");
        for (const socket of this.ctx.getWebSockets()) safeClose(socket, ROOM_ENDED_CLOSE_CODE, ENDED_REASON);
        return this.finishBurial(tombstone);
      }
    }
  }

  /**
   * Notes, frames and shapes with their full content (protocol v11; shapes since v15). Each entry
   * is checked on its own; a message using a ref twice is refused whole. Valid entries fill the
   * room's free note, frame and shape slots in order and the rest are refused (notes_full,
   * frames_full, shapes_full). Text is cleaned and rects clamped as for the single adds; ids, z,
   * rev (1) and author are the server's. New notes and shapes go on top in `rank` order (items
   * without one after, notes then shapes, each in array order), one at a time with zForNew over
   * the shared stacking space; a renumbering at the bound is broadcast first as notesOrdered.
   * Everything is written in one transaction and sent as one itemsAdded (refs and refusals only in
   * the sender's copy). Nothing added: no broadcast, only an error to the sender. Content is
   * untrusted text: cleaned, never logged.
   */
  private handleItems(ws: WebSocket, you: Participant, viewer: string | null, message: ItemsMessage): void {
    const check = checkItems(message.notes, message.frames, message.shapes);
    // A silent round (protocol v17): new notes are sealed with the sender's writer, within its cap.
    const sealing = this.silent.active;
    const sealedBefore = this.notes.sealedCount;
    let sealedSlots = sealing && viewer !== null ? MAX_SEALED_PER_WRITER - this.notes.sealedBy(viewer) : Number.POSITIVE_INFINITY;
    if (check.duplicate) return this.send(ws, error("bad_message", "An item is named twice.", refOf(message)));
    const refused: ItemRefusal[] = [...check.invalid];
    const refuse = (kind: ItemRefusal["kind"], index: number, ref: string, reason: ItemRefusal["reason"]) => refused.push({ kind, index, ref, reason });

    // Notes and shapes that pass cleaning and fit a free slot, in array order (slots are taken in that order).
    type Stackable = { kind: "note"; rank: number | undefined; order: number; ref: string; note: Omit<Note, "z"> } | { kind: "shape"; rank: number | undefined; order: number; ref: string; shape: Omit<Shape, "z"> };
    const stackable: Stackable[] = [];
    let noteSlots = MAX_NOTES_PER_ROOM - this.notes.count;
    for (const { index, entry } of check.notes) {
      const text = cleanNoteText(entry.text);
      if (text === null) {
        refuse("note", index, entry.ref, "invalid");
        continue;
      }
      if (sealing && viewer === null) {
        refuse("note", index, entry.ref, "no_writer");
        continue;
      }
      if (noteSlots <= 0) {
        refuse("note", index, entry.ref, "notes_full");
        continue;
      }
      if (sealedSlots <= 0) {
        refuse("note", index, entry.ref, "sealed_full");
        continue;
      }
      noteSlots--;
      sealedSlots--;
      const { ref, rank, x, y, w, h, text: _, ...style } = entry;
      stackable.push({ kind: "note", rank, order: stackable.length, ref, note: { id: randomBase64url(12), ...clampNoteRect({ x, y, w, h }), text, ...style, rev: 1, authorId: you.id } });
    }
    let shapeSlots = MAX_SHAPES_PER_ROOM - this.notes.shapeCount;
    for (const { index, entry } of check.shapes) {
      const text = cleanShapeText(entry.text);
      if (text === null) {
        refuse("shape", index, entry.ref, "invalid");
        continue;
      }
      if (shapeSlots <= 0) {
        refuse("shape", index, entry.ref, "shapes_full");
        continue;
      }
      shapeSlots--;
      const { ref, rank, x, y, w, h, text: _, ...style } = entry;
      stackable.push({ kind: "shape", rank, order: stackable.length, ref, shape: { id: randomBase64url(12), ...clampShapeRect({ x, y, w, h }), text, ...style, rev: 1, authorId: you.id } });
    }

    // Stacking: ranked items first (by rank, then array order), then the rest; each on top of the last.
    const RANKLESS = Number.MAX_SAFE_INTEGER;
    const byRank = [...stackable].sort((a, b) => (a.rank ?? RANKLESS) - (b.rank ?? RANKLESS) || a.order - b.order);
    let stack: Stacked[] = this.stackItems();
    const zOf = new Map<string, number>();
    for (const item of byRank) {
      const id = item.kind === "note" ? item.note.id : item.shape.id;
      const { z, changes } = zForNew(stack);
      if (changes.length > 0) {
        const renumbered = new Map(changes.map((c) => [c.id, c.z]));
        stack = stack.map((s) => ({ id: s.id, z: renumbered.get(s.id) ?? s.z }));
      }
      stack.push({ id, z });
      zOf.set(id, z);
    }
    // A renumbering may have moved items added earlier in this message too: they take their final z.
    for (const s of stack) if (zOf.has(s.id)) zOf.set(s.id, s.z);
    const renumbered = this.restacked(stack.filter((s) => !zOf.has(s.id)));
    const notes = stackable.flatMap((i) => (i.kind === "note" ? [{ ref: i.ref, note: { ...i.note, z: zOf.get(i.note.id) ?? 0 } as Note }] : []));
    const shapes = stackable.flatMap((i) => (i.kind === "shape" ? [{ ref: i.ref, shape: { ...i.shape, z: zOf.get(i.shape.id) ?? 0 } as Shape }] : []));
    // Notes go out in stacking order (bottom first), as before.
    notes.sort((a, b) => a.note.z - b.note.z);

    const frames: { ref: string; frame: Frame }[] = [];
    let frameSlots = MAX_FRAMES_PER_ROOM - this.notes.frameCount;
    for (const { index, entry } of check.frames) {
      const title = cleanFrameTitle(entry.title);
      if (title === null) {
        refuse("frame", index, entry.ref, "invalid");
        continue;
      }
      if (frameSlots <= 0) {
        refuse("frame", index, entry.ref, "frames_full");
        continue;
      }
      frameSlots--;
      const { ref, x, y, w, h, title: _, ...rest } = entry;
      frames.push({ ref, frame: { id: randomBase64url(12), ...clampFrameRect({ x, y, w, h }), title, ...rest, rev: 1, authorId: you.id } });
    }
    const kindOrder: Record<ItemRefusal["kind"], number> = { note: 0, frame: 1, shape: 2 };
    refused.sort((a, b) => (a.kind === b.kind ? a.index - b.index : kindOrder[a.kind] - kindOrder[b.kind]));

    if (notes.length === 0 && frames.length === 0 && shapes.length === 0) {
      const reasons = new Set(refused.map((r) => r.reason));
      const only = reasons.size === 1 ? [...reasons][0] : undefined;
      const code: ErrorCode = only !== undefined && only !== "invalid" ? only : "bad_message";
      return this.send(ws, { type: "error", code, message: "Nothing was added.", clientRef: message.clientRef, refused });
    }

    this.notes.applyAdds(
      renumbered.notes,
      notes.map((n) => n.note),
      frames.map((f) => f.frame),
      shapes.map((x) => x.shape),
      renumbered.shapes,
      sealing ? viewer : null,
    );
    this.broadcastOrdered(renumbered);
    this.send(ws, { type: "itemsAdded", clientRef: message.clientRef, notes, frames, ...(shapes.length > 0 ? { shapes } : {}), refused });
    this.broadcast(
      {
        type: "itemsAdded",
        notes: notes.map(({ note }) => ({ note })),
        frames: frames.map(({ frame }) => ({ frame })),
        ...(shapes.length > 0 ? { shapes: shapes.map(({ shape }) => ({ shape })) } : {}),
        refused: [],
      },
      ws,
    );
    if (this.notes.sealedCount !== sealedBefore) this.broadcastSilent();
  }

  /** Everything in the stacking space (notes and, since v15, shapes): id and z. */
  private stackItems(): Stacked[] {
    return [...this.notes.all(), ...this.notes.allShapes()].map(({ id, z }) => ({ id, z }));
  }

  /** Tells everyone about renumbered or restacked notes and shapes (if any), as one notesOrdered. */
  private broadcastOrdered(changed: { notes: readonly Note[]; shapes: readonly Shape[] }): void {
    const results = [...changed.notes, ...changed.shapes].map((n) => ({ id: n.id, z: n.z, rev: n.rev }));
    if (results.length > 0) this.broadcast({ type: "notesOrdered", results });
  }

  /**
   * Frames: last-write-wins in arrival order, every stored change bumps rev, unknown or deleted
   * frames are ignored silently. A final frameMove carries the notes it names by the same delta,
   * clamped once for the whole group, in one transaction and one frameMoved (with the notes).
   * Live moves and resizes are relayed to the others, coalesced, never stored. Titles are untrusted
   * text: cleaned, never logged.
   */
  private handleFrame(ws: WebSocket, you: Participant, viewer: string | null, message: FrameMessage): void {
    switch (message.type) {
      case "frameAdd": {
        if (this.notes.frameCount >= MAX_FRAMES_PER_ROOM) {
          return this.send(ws, error("frames_full", `This board has the maximum of ${MAX_FRAMES_PER_ROOM} frames.`, refOf(message)));
        }
        const title = cleanFrameTitle(message.title);
        if (title === null) return this.send(ws, error("bad_message", "Frame title is too long.", refOf(message)));
        const frame: Frame = {
          id: randomBase64url(12),
          ...clampFrameRect({ x: message.x, y: message.y, w: FRAME_DEFAULT_W, h: FRAME_DEFAULT_H }),
          title,
          color: message.color,
          ...FRAME_DEFAULTS,
          rev: 1,
          authorId: you.id,
        };
        this.notes.insertFrame(frame);
        this.send(ws, { type: "frameAdded", frame, clientRef: message.clientRef });
        this.broadcast({ type: "frameAdded", frame }, ws);
        return;
      }

      case "frameEdit": {
        const current = this.notes.getFrame(message.id);
        if (!current) return;
        const title = message.title === undefined ? current.title : cleanFrameTitle(message.title);
        if (title === null) return this.send(ws, error("bad_message", "Frame title is too long.", refOf(message)));
        const next: Frame = { ...current, title, color: message.color ?? current.color };
        for (const field of FRAME_STYLE_FIELDS) {
          const value = message[field];
          if (value !== undefined) Object.assign(next, { [field]: value });
        }
        if (FRAME_EDIT_FIELDS.every((field) => next[field] === current[field])) return;
        const frame: Frame = { ...next, rev: current.rev + 1 };
        this.notes.updateFrame(frame);
        this.broadcast({ type: "frameUpdated", frame });
        return;
      }

      case "frameMove": {
        const current = this.notes.getFrame(message.id);
        if (!current) return;
        // Someone else's sealed note is never carried (a silent round refuses frameMove anyway).
        const carried = (message.noteIds ?? []).flatMap((id) => this.noteFor(viewer, id) ?? []);
        const carriedShapes = (message.shapeIds ?? []).flatMap((id) => this.notes.getShape(id) ?? []);
        const target = clampFramePosition(message.x, message.y, current);
        const { dx, dy } =
          carried.length + carriedShapes.length > 0
            ? groupOffset([current, ...carried, ...carriedShapes], target.x - current.x, target.y - current.y)
            : { dx: target.x - current.x, dy: target.y - current.y };
        const x = current.x + dx;
        const y = current.y + dy;
        const placed = carried.map((note) => ({ note, ...clampNotePosition(note.x + dx, note.y + dy, note) }));
        const placedShapes = carriedShapes.map((shape) => ({ shape, ...clampShapePosition(shape.x + dx, shape.y + dy, shape) }));
        if (!message.final) {
          this.pendingFrames.set(`move:${current.id}`, {
            from: ws,
            message: {
              type: "frameMoved",
              id: current.id,
              x,
              y,
              rev: current.rev,
              final: false,
              ...(placed.length > 0 ? { notes: placed.map(({ note, x: nx, y: ny }) => ({ id: note.id, x: nx, y: ny, rev: note.rev })) } : {}),
              ...(placedShapes.length > 0 ? { shapes: placedShapes.map(({ shape, x: sx, y: sy }) => ({ id: shape.id, x: sx, y: sy, rev: shape.rev })) } : {}),
            },
          });
          this.scheduleFlush();
          return;
        }
        const frame = x !== current.x || y !== current.y ? { ...current, x, y, rev: current.rev + 1 } : null;
        const changed: Note[] = [];
        const notes = placed.map(({ note, x: nx, y: ny }) => {
          if (nx === note.x && ny === note.y) return note;
          const next = { ...note, x: nx, y: ny, rev: note.rev + 1 };
          changed.push(next);
          return next;
        });
        const changedShapes: Shape[] = [];
        const shapes = placedShapes.map(({ shape, x: sx, y: sy }) => {
          if (sx === shape.x && sy === shape.y) return shape;
          const next = { ...shape, x: sx, y: sy, rev: shape.rev + 1 };
          changedShapes.push(next);
          return next;
        });
        // The frame and every changed note and shape in one transaction: 1 + N + M rows at most.
        this.notes.applyFrameMove(frame, changed, changedShapes);
        const moved = frame ?? current;
        // Reported even when unchanged, so everyone who saw the drag sees where it ended.
        this.broadcast({
          type: "frameMoved",
          id: moved.id,
          x: moved.x,
          y: moved.y,
          rev: moved.rev,
          final: true,
          ...(notes.length > 0 ? { notes: notes.map((n) => ({ id: n.id, x: n.x, y: n.y, rev: n.rev })) } : {}),
          ...(shapes.length > 0 ? { shapes: shapes.map((n) => ({ id: n.id, x: n.x, y: n.y, rev: n.rev })) } : {}),
        });
        return;
      }

      case "frameResize": {
        const current = this.notes.getFrame(message.id);
        if (!current) return;
        const rect = clampFrameRect(message);
        if (!message.final) {
          this.pendingFrames.set(`resize:${current.id}`, { from: ws, message: { type: "frameResized", id: current.id, ...rect, rev: current.rev, final: false } });
          this.scheduleFlush();
          return;
        }
        let frame = current;
        if (rect.x !== current.x || rect.y !== current.y || rect.w !== current.w || rect.h !== current.h) {
          frame = { ...current, ...rect, rev: current.rev + 1 };
          this.notes.updateFrame(frame);
        }
        this.broadcast({ type: "frameResized", id: frame.id, x: frame.x, y: frame.y, w: frame.w, h: frame.h, rev: frame.rev, final: true });
        return;
      }

      case "frameDelete": {
        // Only the frame: notes inside it stay where they are.
        if (!this.notes.getFrame(message.id)) return;
        this.notes.deleteFrame(message.id);
        this.broadcast({ type: "frameDeleted", id: message.id });
        return;
      }
    }
  }

  /**
   * Bring to front / send to back, computed from the room's current stacking (so the later of
   * two arrives on top). Invalid ids are named back to the sender by index while the rest apply;
   * a message naming a note twice is refused whole; unknown and deleted notes are ignored. Only
   * notes whose z changes are written (one rev bump each, one transaction); everyone gets one
   * notesOrdered with every named note, changed or not, and any note a renumbering moved.
   */
  private handleOrder(ws: WebSocket, viewer: string | null, message: OrderMessage): void {
    const { valid, invalid, invalidIds } = checkOrder(message.ids);
    if (invalid.length > 0) {
      this.send(ws, {
        type: "error",
        code: "bad_message",
        message: "Some notes could not be understood.",
        entries: invalid,
        ...(invalidIds.length > 0 ? { noteIds: invalidIds } : {}),
      });
    }
    // Notes and shapes share the stacking space (v15); anything else (a frame, a deleted id) is ignored.
    // Someone else's sealed note (protocol v17) is unknown too.
    const ids = valid.map((v) => v.id).filter((id) => this.noteFor(viewer, id) ?? this.notes.getShape(id));
    if (ids.length === 0) return;
    const { changes } = restack(this.stackItems(), ids, message.action);
    const updates = this.restacked(changes);
    this.notes.applyBatch(updates.notes, [], updates.shapes);
    const reported = new Set([...ids, ...updates.notes.map((n) => n.id), ...updates.shapes.map((n) => n.id)]);
    const results = [...reported].flatMap((id) => {
      const item = this.notes.get(id) ?? this.notes.getShape(id);
      return item ? [{ id, z: item.z, rev: item.rev }] : [];
    });
    this.broadcast({ type: "notesOrdered", results });
  }

  /** Notes and shapes with their new z (and a rev bump), from stacking changes. */
  private restacked(changes: readonly Stacked[]): { notes: Note[]; shapes: Shape[] } {
    const notes: Note[] = [];
    const shapes: Shape[] = [];
    for (const { id, z } of changes) {
      const note = this.notes.get(id);
      if (note) {
        if (note.z !== z) notes.push({ ...note, z, rev: note.rev + 1 });
        continue;
      }
      const shape = this.notes.getShape(id);
      if (shape && shape.z !== z) shapes.push({ ...shape, z, rev: shape.rev + 1 });
    }
    return { notes, shapes };
  }

  /**
   * Many moves, resizes and deletes. Each entry is checked on its own: invalid ones are named
   * back to the sender by index (and note id) while the rest apply; a batch naming a note twice
   * is refused whole. Unknown and deleted notes are ignored silently. Final batches are stored
   * in one transaction (one rev bump per changed note) and sent to everyone as one
   * notesBatchApplied; live ones (a group drag) are relayed to the others, coalesced, never stored.
   */
  private handleBatch(ws: WebSocket, viewer: string | null, message: BatchMessage): void {
    const { valid, invalid, invalidIds } = checkBatch(message.ops);
    if (invalid.length > 0) {
      this.send(ws, {
        type: "error",
        code: "bad_message",
        message: "Some changes could not be understood.",
        entries: invalid,
        ...(invalidIds.length > 0 ? { noteIds: invalidIds } : {}),
      });
    }
    if (!message.final) {
      for (const { entry } of valid) {
        // Deletes are never previews; a live batch only moves and resizes.
        if (entry.op === "delete") continue;
        const current = this.noteFor(viewer, entry.id);
        if (!current) continue;
        const relayed: Pending["message"] =
          entry.op === "move"
            ? { type: "noteMoved", id: current.id, ...clampNotePosition(entry.x, entry.y, current), rev: current.rev, final: false }
            : { type: "noteResized", id: current.id, ...clampNoteRect(entry), rev: current.rev, final: false };
        this.pendingMoves.set(`${entry.op}:${current.id}`, { from: ws, message: relayed, batch: true });
      }
      this.scheduleFlush();
      return;
    }
    const updates: Note[] = [];
    const deletes: string[] = [];
    const results: NoteBatchResult[] = [];
    const sealedBefore = this.notes.sealedCount;
    for (const { entry } of valid) {
      const current = this.noteFor(viewer, entry.id);
      if (!current) continue;
      if (entry.op === "delete") {
        deletes.push(current.id);
        results.push({ type: "noteDeleted", id: current.id });
        continue;
      }
      const rect = entry.op === "move" ? { ...clampNotePosition(entry.x, entry.y, current), w: current.w, h: current.h } : clampNoteRect(entry);
      let note = current;
      if (rect.x !== current.x || rect.y !== current.y || rect.w !== current.w || rect.h !== current.h) {
        note = { ...current, ...rect, rev: current.rev + 1 };
        updates.push(note);
      }
      // Reported even when unchanged, so everyone who saw the drag sees where it ended.
      results.push(
        entry.op === "move"
          ? { type: "noteMoved", id: note.id, x: note.x, y: note.y, rev: note.rev, final: true }
          : { type: "noteResized", id: note.id, x: note.x, y: note.y, w: note.w, h: note.h, rev: note.rev, final: true },
      );
    }
    this.notes.applyBatch(updates, deletes);
    if (results.length > 0) this.broadcast({ type: "notesBatchApplied", results, final: true });
    if (this.notes.sealedCount !== sealedBefore) this.broadcastSilent();
  }

  /**
   * Last-write-wins, in arrival order. Every stored change bumps the note's rev.
   * Edits, moves and deletes of an unknown (or already deleted) note are ignored silently.
   * Logging hygiene: nothing here logs note text (or anything else).
   */
  private handleNote(ws: WebSocket, you: Participant, viewer: string | null, message: NoteMessage): void {
    switch (message.type) {
      case "noteAdd": {
        if (this.notes.count >= MAX_NOTES_PER_ROOM) {
          return this.send(ws, error("notes_full", `This board has the maximum of ${MAX_NOTES_PER_ROOM} notes.`, refOf(message)));
        }
        // A silent round (protocol v17): the note is sealed with the sender's writer, within its cap.
        const writer = this.silent.active ? viewer : null;
        if (this.silent.active && viewer === null) return this.send(ws, error("no_writer", "This page can't add notes during a silent round. Reload to join it.", refOf(message)));
        if (writer !== null && this.notes.sealedBy(writer) >= MAX_SEALED_PER_WRITER) {
          return this.send(ws, error("sealed_full", `You have the maximum of ${MAX_SEALED_PER_WRITER} notes for this silent round.`, refOf(message)));
        }
        const text = cleanNoteText(message.text);
        if (text === null) return this.send(ws, error("bad_message", "Note text is too long.", refOf(message)));
        // A new note goes on top of every note and shape. At the bound the others are renumbered first, and everyone hears.
        const stack = this.newOnTop();
        // The id, z, rev and author are the server's; the author comes from this socket.
        // A new note has the default size and style; noteAdd carries neither.
        const note: Note = {
          id: randomBase64url(12),
          ...NOTE_DEFAULTS,
          ...clampNotePosition(message.x, message.y),
          text,
          color: message.color,
          z: stack.z,
          rev: 1,
          authorId: you.id,
        };
        this.notes.insert(note, writer);
        this.send(ws, { type: "noteAdded", note, clientRef: message.clientRef });
        // A sealed note reaches only its writer's other sockets (broadcast filters); everyone gets the count.
        this.broadcast({ type: "noteAdded", note }, ws);
        if (writer !== null) this.broadcastSilent();
        return;
      }

      case "noteEdit": {
        const current = this.noteFor(viewer, message.id);
        if (!current) return;
        let next: Note = current;
        if (message.text !== undefined) {
          const text = cleanNoteText(message.text);
          if (text === null) return this.send(ws, error("bad_message", "Note text is too long.", refOf(message)));
          next = { ...next, text };
        }
        // Keys only (the schema refused anything else); position, size and author never change here.
        next = {
          ...next,
          color: message.color ?? next.color,
          fontSize: message.fontSize ?? next.fontSize,
          bold: message.bold ?? next.bold,
          italic: message.italic ?? next.italic,
          textColor: message.textColor ?? next.textColor,
          align: message.align ?? next.align,
          titleAlign: message.titleAlign ?? next.titleAlign,
          titleFontSize: message.titleFontSize ?? next.titleFontSize,
          titleBold: message.titleBold ?? next.titleBold,
          titleItalic: message.titleItalic ?? next.titleItalic,
          titleTextColor: message.titleTextColor ?? next.titleTextColor,
        };
        if (NOTE_EDIT_FIELDS.every((field) => next[field] === current[field])) return;
        const note: Note = { ...next, rev: current.rev + 1 };
        this.notes.update(note);
        this.broadcast({ type: "noteUpdated", note });
        return;
      }

      case "noteMove": {
        const current = this.noteFor(viewer, message.id);
        if (!current) return;
        const { x, y } = clampNotePosition(message.x, message.y, current);
        if (!message.final) {
          // Relayed to the others only, at the current rev; never stored.
          this.pendingMoves.set(`move:${current.id}`, {
            from: ws,
            message: { type: "noteMoved", id: current.id, x, y, rev: current.rev, final: false },
            batch: false,
          });
          this.scheduleFlush();
          return;
        }
        let note = current;
        if (x !== current.x || y !== current.y) {
          note = { ...current, x, y, rev: current.rev + 1 };
          this.notes.update(note);
        }
        // Sent even when unchanged, so everyone who saw the drag sees where it ended.
        this.broadcast({ type: "noteMoved", id: note.id, x: note.x, y: note.y, rev: note.rev, final: true });
        return;
      }

      case "noteResize": {
        const current = this.noteFor(viewer, message.id);
        if (!current) return;
        // Size first, then position, so the whole note stays on the board.
        const rect = clampNoteRect(message);
        if (!message.final) {
          this.pendingMoves.set(`resize:${current.id}`, {
            from: ws,
            message: { type: "noteResized", id: current.id, ...rect, rev: current.rev, final: false },
            batch: false,
          });
          this.scheduleFlush();
          return;
        }
        let note = current;
        if (rect.x !== current.x || rect.y !== current.y || rect.w !== current.w || rect.h !== current.h) {
          note = { ...current, ...rect, rev: current.rev + 1 };
          this.notes.update(note);
        }
        this.broadcast({ type: "noteResized", id: note.id, x: note.x, y: note.y, w: note.w, h: note.h, rev: note.rev, final: true });
        return;
      }

      case "noteDelete": {
        if (!this.noteFor(viewer, message.id)) return;
        const sealed = this.notes.writerOf(message.id) !== null;
        this.notes.delete(message.id);
        this.broadcast({ type: "noteDeleted", id: message.id });
        if (sealed) this.broadcastSilent();
        return;
      }
    }
  }

  /** The z for a new note or shape: on top. A renumbering at the bound is written and broadcast first. */
  private newOnTop(): { z: number } {
    const stack = zForNew(this.stackItems());
    const renumbered = this.restacked(stack.changes);
    if (renumbered.notes.length + renumbered.shapes.length > 0) {
      this.notes.applyBatch(renumbered.notes, [], renumbered.shapes);
      this.broadcastOrdered(renumbered);
    }
    return { z: stack.z };
  }

  /**
   * Shapes (protocol v15): last-write-wins in arrival order, every stored change bumps rev,
   * unknown or deleted shapes ignored silently, an unchanged edit writes and sends nothing. Live
   * moves and resizes are relayed to the others, coalesced, never stored. Text is untrusted:
   * cleaned, never logged. The kind never changes.
   */
  private handleShape(ws: WebSocket, you: Participant, message: ShapeMessage): void {
    switch (message.type) {
      case "shapeAdd": {
        if (this.notes.shapeCount >= MAX_SHAPES_PER_ROOM) {
          return this.send(ws, error("shapes_full", `This board has the maximum of ${MAX_SHAPES_PER_ROOM} shapes.`, refOf(message)));
        }
        const { w, h, ...style } = shapeDefaults(message.kind);
        const { z } = this.newOnTop();
        const shape: Shape = { id: randomBase64url(12), kind: message.kind, ...clampShapeRect({ x: message.x, y: message.y, w, h }), text: "", ...style, z, rev: 1, authorId: you.id };
        this.notes.insertShape(shape);
        this.send(ws, { type: "shapeAdded", shape, clientRef: message.clientRef });
        this.broadcast({ type: "shapeAdded", shape }, ws);
        return;
      }

      case "shapeEdit": {
        const current = this.notes.getShape(message.id);
        if (!current) return;
        const text = message.text === undefined ? current.text : cleanShapeText(message.text);
        if (text === null) return this.send(ws, error("bad_message", "Shape text is too long.", refOf(message)));
        const next: Shape = { ...current, text };
        for (const field of SHAPE_STYLE_FIELDS) {
          const value = message[field];
          if (value !== undefined) Object.assign(next, { [field]: value });
        }
        if (SHAPE_EDIT_FIELDS.every((field) => next[field] === current[field])) return;
        const shape: Shape = { ...next, rev: current.rev + 1 };
        this.notes.updateShape(shape);
        this.broadcast({ type: "shapeUpdated", shape });
        return;
      }

      case "shapeMove": {
        const current = this.notes.getShape(message.id);
        if (!current) return;
        const { x, y } = clampShapePosition(message.x, message.y, current);
        if (!message.final) {
          this.pendingShapes.set(`move:${current.id}`, { from: ws, message: { type: "shapeMoved", id: current.id, x, y, rev: current.rev, final: false }, batch: false });
          this.scheduleFlush();
          return;
        }
        let shape = current;
        if (x !== current.x || y !== current.y) {
          shape = { ...current, x, y, rev: current.rev + 1 };
          this.notes.updateShape(shape);
        }
        // Sent even when unchanged, so everyone who saw the drag sees where it ended.
        this.broadcast({ type: "shapeMoved", id: shape.id, x: shape.x, y: shape.y, rev: shape.rev, final: true });
        return;
      }

      case "shapeResize": {
        const current = this.notes.getShape(message.id);
        if (!current) return;
        const rect = clampShapeRect(message);
        if (!message.final) {
          this.pendingShapes.set(`resize:${current.id}`, { from: ws, message: { type: "shapeResized", id: current.id, ...rect, rev: current.rev, final: false }, batch: false });
          this.scheduleFlush();
          return;
        }
        let shape = current;
        if (rect.x !== current.x || rect.y !== current.y || rect.w !== current.w || rect.h !== current.h) {
          shape = { ...current, ...rect, rev: current.rev + 1 };
          this.notes.updateShape(shape);
        }
        this.broadcast({ type: "shapeResized", id: shape.id, x: shape.x, y: shape.y, w: shape.w, h: shape.h, rev: shape.rev, final: true });
        return;
      }

      case "shapeDelete": {
        if (!this.notes.getShape(message.id)) return;
        this.notes.deleteShape(message.id);
        this.broadcast({ type: "shapeDeleted", id: message.id });
        return;
      }
    }
  }

  /**
   * Many shape moves, resizes and deletes, exactly like handleBatch for notes: invalid entries
   * named back by index (and shape id) while the rest apply; a shape named twice refuses the whole
   * batch; unknown and deleted shapes ignored. Final: one transaction, one rev bump per changed
   * shape, one shapesBatchApplied to everyone. Live: relayed to the others, coalesced, never
   * stored (deletes ignored).
   */
  private handleShapeBatch(ws: WebSocket, message: ShapeBatchMessage): void {
    const { valid, invalid, invalidIds } = checkShapeBatch(message.ops);
    if (invalid.length > 0) {
      this.send(ws, {
        type: "error",
        code: "bad_message",
        message: "Some changes could not be understood.",
        entries: invalid,
        ...(invalidIds.length > 0 ? { shapeIds: invalidIds } : {}),
      });
    }
    if (!message.final) {
      for (const { entry } of valid) {
        if (entry.op === "delete") continue;
        const current = this.notes.getShape(entry.id);
        if (!current) continue;
        const relayed: PendingShape["message"] =
          entry.op === "move"
            ? { type: "shapeMoved", id: current.id, ...clampShapePosition(entry.x, entry.y, current), rev: current.rev, final: false }
            : { type: "shapeResized", id: current.id, ...clampShapeRect(entry), rev: current.rev, final: false };
        this.pendingShapes.set(`${entry.op}:${current.id}`, { from: ws, message: relayed, batch: true });
      }
      this.scheduleFlush();
      return;
    }
    const updates: Shape[] = [];
    const deletes: string[] = [];
    const results: ShapeBatchResult[] = [];
    for (const { entry } of valid) {
      const current = this.notes.getShape(entry.id);
      if (!current) continue;
      if (entry.op === "delete") {
        deletes.push(current.id);
        results.push({ type: "shapeDeleted", id: current.id });
        continue;
      }
      const rect = entry.op === "move" ? { ...clampShapePosition(entry.x, entry.y, current), w: current.w, h: current.h } : clampShapeRect(entry);
      let shape = current;
      if (rect.x !== current.x || rect.y !== current.y || rect.w !== current.w || rect.h !== current.h) {
        shape = { ...current, ...rect, rev: current.rev + 1 };
        updates.push(shape);
      }
      results.push(
        entry.op === "move"
          ? { type: "shapeMoved", id: shape.id, x: shape.x, y: shape.y, rev: shape.rev, final: true }
          : { type: "shapeResized", id: shape.id, x: shape.x, y: shape.y, w: shape.w, h: shape.h, rev: shape.rev, final: true },
      );
    }
    this.notes.applyShapeBatch(updates, deletes);
    if (results.length > 0) this.broadcast({ type: "shapesBatchApplied", results, final: true });
  }

  /** Drags and resizes that arrive together are coalesced: only the latest per note (and kind) is relayed. */
  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    setTimeout(() => this.flushMoves(), 0);
  }

  private flushMoves(): void {
    this.flushScheduled = false;
    if (this.pendingFrames.size > 0) {
      const frames = [...this.pendingFrames.values()];
      this.pendingFrames.clear();
      // A frame deleted since then is not moved or resized.
      for (const { from, message } of frames) if (this.notes.getFrame(message.id)) this.broadcast(message, from);
    }
    if (this.pendingShapes.size > 0) {
      // A shape deleted since then is not moved or resized.
      const shapes = [...this.pendingShapes.values()].filter(({ message }) => this.notes.getShape(message.id));
      this.pendingShapes.clear();
      for (const { from, message } of shapes.filter((p) => !p.batch)) this.broadcast(message, from);
      const bySender = new Map<WebSocket, PendingShape["message"][]>();
      for (const { from, message } of shapes.filter((p) => p.batch)) bySender.set(from, [...(bySender.get(from) ?? []), message]);
      for (const [from, results] of bySender) {
        for (let i = 0; i < results.length; i += MAX_BATCH_ENTRIES) {
          this.broadcast({ type: "shapesBatchApplied", results: results.slice(i, i + MAX_BATCH_ENTRIES), final: false }, from);
        }
      }
    }
    if (this.pendingMoves.size === 0) return;
    const pending = [...this.pendingMoves.values()];
    this.pendingMoves.clear();
    // A note deleted since then is not moved or resized.
    const live = pending.filter(({ message }) => this.notes.get(message.id));
    for (const { from, message } of live.filter((p) => !p.batch)) this.broadcast(message, from);
    // Group drags go out as one notesBatchApplied per sender (in chunks of MAX_BATCH_ENTRIES).
    const bySender = new Map<WebSocket, Pending["message"][]>();
    for (const { from, message } of live.filter((p) => p.batch)) bySender.set(from, [...(bySender.get(from) ?? []), message]);
    for (const [from, results] of bySender) {
      for (let i = 0; i < results.length; i += MAX_BATCH_ENTRIES) {
        this.broadcast({ type: "notesBatchApplied", results: results.slice(i, i + MAX_BATCH_ENTRIES), final: false }, from);
      }
    }
  }

  /** Joined participants on open sockets, in connection order, with the writer each socket sees as. */
  private participants(): { ws: WebSocket; participant: Participant; writerId: string | null }[] {
    return this.ctx.getWebSockets().flatMap((ws) => {
      if (ws.readyState !== WebSocket.OPEN) return [];
      const state = readState(ws);
      return state?.participant ? [{ ws, participant: state.participant, writerId: state.writerId }] : [];
    });
  }

  /**
   * Whether this message must be filtered per recipient (protocol v17): it can carry note content
   * (SERVER_MESSAGES) and some note is sealed (or was, earlier in this message).
   */
  private filtered(message: ServerMessage): boolean {
    return SERVER_MESSAGES[message.type].carriesNoteContent && (this.store?.hasSealed ?? false);
  }

  /** The message as a socket seeing as `viewer` may get it: someone else's sealed notes left out (sealed.ts). */
  private forViewer(message: ServerMessage, viewer: string | null): ServerMessage | null {
    if (!this.filtered(message)) return message;
    return scrubFor(message, (id) => canSee(this.store?.writerOf(id) ?? null, viewer));
  }

  /** Every message to one socket goes through here, so a sealed note reaches only its writer's sockets. */
  private send(ws: WebSocket, message: ServerMessage): void {
    const out = this.filtered(message) ? this.forViewer(message, readState(ws)?.writerId ?? null) : message;
    if (out) sendRaw(ws, encodeMessage(out));
  }

  /** To every joined socket but `except`, each getting what its writer may see (encoded once per writer). */
  private broadcast(message: ServerMessage, except?: WebSocket): void {
    if (!this.filtered(message)) {
      const raw = encodeMessage(message);
      for (const { ws } of this.participants()) if (ws !== except) sendRaw(ws, raw);
      return;
    }
    const byViewer = new Map<string | null, string | null>();
    for (const { ws, writerId } of this.participants()) {
      if (ws === except) continue;
      if (!byViewer.has(writerId)) {
        const out = this.forViewer(message, writerId);
        byViewer.set(writerId, out ? encodeMessage(out) : null);
      }
      const raw = byViewer.get(writerId);
      if (raw) sendRaw(ws, raw);
    }
  }

  /**
   * If the others were sent this socket's cursor, tell them it has gone (cursorGone) and forget it.
   * Sent alongside participant_left on purpose: a page's cursors then never depend on a second
   * message kind, and it costs one small message, only for a cursor that was showing.
   */
  private hideCursor(ws: WebSocket, state = readState(ws)): void {
    if (!state?.cursorShown || !state.participant) return;
    state.cursorShown = false;
    try {
      ws.serializeAttachment(state);
    } catch {
      // The socket is already gone.
    }
    this.broadcast({ type: "cursorGone", id: state.participant.id }, ws);
  }

  /** Forget the socket's participant and tell everyone else (its cursor first). Safe to call twice. */
  private leave(ws: WebSocket, state: SocketState): void {
    const left = state.participant;
    if (!left) return;
    this.hideCursor(ws, state);
    state.participant = null;
    try {
      ws.serializeAttachment(state);
    } catch {
      // The socket is already gone; it no longer counts as open either way.
    }
    this.broadcast({ type: "participant_left", id: left.id }, ws);
  }
}

/** Entries a message spends from BATCH_LIMITS: batch ops, restack ids, the notes and shapes a final frame move carries, and added items. */
export function entriesOf(message: ClientMessage): number {
  switch (message.type) {
    case "itemsAdd":
      return (message.notes?.length ?? 0) + (message.frames?.length ?? 0) + (message.shapes?.length ?? 0);
    case "noteBatch":
    case "shapeBatch":
      return message.ops.length;
    case "notesOrder":
      return message.ids.length;
    case "frameMove":
      return message.final ? (message.noteIds?.length ?? 0) + (message.shapeIds?.length ?? 0) : 0;
    default:
      return 0;
  }
}

function readState(ws: WebSocket): SocketState | null {
  const parsed = socketStateSchema.safeParse(ws.deserializeAttachment());
  return parsed.success ? parsed.data : null;
}

/** Sends an encoded message as is. Room.send / Room.broadcast decide what each recipient may see first. */
function sendRaw(ws: WebSocket, raw: string): void {
  try {
    ws.send(raw);
  } catch {
    // Closed or closing: nothing to do.
  }
}

function safeClose(ws: WebSocket, code: number, reason: string): void {
  try {
    ws.close(code, reason);
  } catch {
    // Already closed.
  }
}
