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
  clampFramePosition,
  clampFrameRect,
  clampNotePosition,
  checkBatch,
  checkItems,
  checkOrder,
  clampNoteRect,
  clientMessageSchema,
  cleanFrameTitle,
  cleanName,
  cleanNoteText,
  cleanText,
  encodeMessage,
  groupOffset,
  parseMessage,
  participantSchema,
  restack,
  zForNew,
  type ClientMessage,
  type ErrorCode,
  type Frame,
  type ItemRefusal,
  type Note,
  type NoteBatchResult,
  type Participant,
  type ServerMessage,
  type Stacked,
  type TimerState,
  type VotingState,
} from "@stickyard/shared";
import { z } from "zod";
import { randomBase64url } from "./crypto";
import type { Secrets } from "./env";
import { ENDED_REASON, EXPIRED_REASON, clearToTombstone, nextExpiryAlarm, readTombstone, writeTombstone, type Tombstone, type TombstoneKind } from "./expiry";
import { verifyHostToken } from "./hostToken";
import { BATCH_LIMITS, SOCKET_LIMITS } from "./limits";
import { NoteStore } from "./noteStore";
import { voterIdFor } from "./voterId";

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
  /** Batch entries token bucket (BATCH_LIMITS). Defaults keep sockets from before v7 readable. */
  entryTokens: z.number().default(BATCH_LIMITS.entriesBurst),
  entryAt: z.number().default(0),
});
type SocketState = z.infer<typeof socketStateSchema>;

/** Which note or frame (or pending add) an error is about, so the sender can roll back. */
type ErrorRef =
  | { clientRef: string }
  | { noteId: string }
  | { noteIds: string[] }
  | { frameId: string; noteIds?: string[] }
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
      return { clientRef: message.clientRef };
    case "frameEdit":
    case "frameResize":
    case "frameDelete":
      return { frameId: message.id };
    case "voteSet":
      return { noteId: message.noteId };
    case "frameMove":
      // The notes it was carrying roll back with it.
      return message.noteIds && message.noteIds.length > 0 ? { frameId: message.id, noteIds: message.noteIds } : { frameId: message.id };
    default:
      return {};
  }
}

type NoteMessage = Extract<ClientMessage, { type: "noteAdd" | "noteEdit" | "noteMove" | "noteResize" | "noteDelete" }>;
type BatchMessage = Extract<ClientMessage, { type: "noteBatch" }>;
type OrderMessage = Extract<ClientMessage, { type: "notesOrder" }>;
type FrameMessage = Extract<ClientMessage, { type: "frameAdd" | "frameEdit" | "frameMove" | "frameResize" | "frameDelete" }>;
type ItemsMessage = Extract<ClientMessage, { type: "itemsAdd" }>;
type VotingHostMessage = Extract<ClientMessage, { type: "voteStart" | "voteStop" | "voteClear" }>;

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
    message.type === "frameResize") &&
  !message.final;

/** A frame's live move or resize waiting to be relayed (latest per frame and kind). */
interface PendingFrame {
  from: WebSocket;
  message: Extract<ServerMessage, { type: "frameMoved" | "frameResized" }>;
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
  /** Rows written outside the current store: alarm sets, tombstones, and a store dropped at burial. */
  private otherRows = 0;
  /** Non-final moves and resizes waiting to be relayed, latest per note and kind. Never stored. */
  private readonly pendingMoves = new Map<string, Pending>();
  /** Frames' live moves and resizes, likewise. */
  private readonly pendingFrames = new Map<string, PendingFrame>();
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
      tokens: SOCKET_LIMITS.burst,
      at: Date.now(),
      strikes: 0,
      strikeAt: 0,
      entryTokens: BATCH_LIMITS.entriesBurst,
      entryAt: Date.now(),
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

    // Rate limit every frame, valid or not, before parsing it.
    const now = Date.now();
    state.tokens = Math.min(SOCKET_LIMITS.burst, state.tokens + ((now - state.at) / 1000) * SOCKET_LIMITS.refillPerSecond);
    state.at = now;
    if (state.tokens < 1) {
      // The message is dropped. Name the note it was about (if any) so the sender can roll back.
      const dropped = parseMessage(message, clientMessageSchema);
      await this.overLimit(ws, state, now, dropped.ok ? refOf(dropped.value) : {});
      return;
    }
    state.tokens -= 1;

    const parsed = parseMessage(message, clientMessageSchema);
    if (!parsed.ok) {
      ws.serializeAttachment(state);
      send(
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
   * A violation (over a rate budget, or a wrong host token): answered with `reply`, and counted.
   * Violations are counted per window, not consecutively, so a sender at twice the rate still
   * gets closed.
   */
  private async violation(ws: WebSocket, state: SocketState, now: number, reply: ServerMessage): Promise<void> {
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
    send(ws, reply);
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
    this.pendingMoves.clear();
    this.pendingFrames.clear();
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

    // A locked board refuses a non-host's changes (protocol v12): nothing written or relayed, and
    // the refusal names what to roll back. BOARD_WRITES classifies every message type.
    if (BOARD_WRITES[message.type] && this.locked && state.participant && !state.participant.host) {
      ws.serializeAttachment(state);
      return send(ws, error("board_locked", "The host has locked the board.", refOf(message)));
    }

    switch (message.type) {
      case "hello": {
        if (message.protocolVersion !== PROTOCOL_VERSION) {
          ws.serializeAttachment(state);
          send(ws, error("version_mismatch", `Server speaks protocol v${PROTOCOL_VERSION}. Please reload.`));
          return;
        }
        state.hello = true;
        ws.serializeAttachment(state);
        send(ws, { type: "welcome", protocolVersion: PROTOCOL_VERSION });
        return;
      }

      case "join": {
        ws.serializeAttachment(state);
        if (!state.hello) return send(ws, error("bad_message", "Say hello first."));
        if (state.participant) return send(ws, error("already_joined", "Already joined."));
        const name = cleanName(message.name);
        if (name === null) return send(ws, error("invalid_name", "Names need 1 to 24 visible characters."));
        const others = this.participants();
        if (others.length >= MAX_PARTICIPANTS) return send(ws, error("room_full", "This room is full."));

        const used = new Set(others.map(({ participant }) => participant.colourIndex));
        let colourIndex = 0;
        while (used.has(colourIndex)) colourIndex++;
        const you: Participant = { id: randomBase64url(12), name, colourIndex, host: false };
        state.participant = you;
        ws.serializeAttachment(state);

        // Lock and timer ride on joined, in this same step as the snapshots: nothing can land between them.
        send(ws, {
          type: "joined",
          you,
          participants: this.participants().map(({ participant }) => participant),
          locked: this.locked,
          timer: this.timerView(),
          voting: this.voting,
        });
        // Notes, then frames, in this same step: nothing else can be sent to this socket between them.
        send(ws, { type: "snapshot", notes: this.notes.all() });
        send(ws, { type: "framesSnapshot", frames: this.notes.allFrames() });
        // A closed round's totals, so a late joiner sees the results. While open, nothing about anyone's votes.
        if (this.voting.state === "closed") send(ws, this.revealed());
        this.broadcast({ type: "participant_joined", participant: you }, ws);
        return;
      }

      case "say": {
        ws.serializeAttachment(state);
        if (!state.participant) return send(ws, error("not_joined", "Join the room first."));
        const text = cleanText(message.text);
        if (text === null) return send(ws, error("bad_message", "Messages need 1 to 280 visible characters."));
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
        if (!state.participant) return send(ws, error("not_joined", "Join the room first.", refOf(message)));
        this.handleNote(ws, state.participant, message);
        return;
      }

      case "noteBatch": {
        ws.serializeAttachment(state);
        if (!state.participant) return send(ws, error("not_joined", "Join the room first.", refOf(message)));
        this.handleBatch(ws, message);
        return;
      }

      case "notesOrder": {
        ws.serializeAttachment(state);
        if (!state.participant) return send(ws, error("not_joined", "Join the room first.", refOf(message)));
        this.handleOrder(ws, message);
        return;
      }

      case "frameAdd":
      case "frameEdit":
      case "frameMove":
      case "frameResize":
      case "frameDelete": {
        ws.serializeAttachment(state);
        if (!state.participant) return send(ws, error("not_joined", "Join the room first.", refOf(message)));
        this.handleFrame(ws, state.participant, message);
        return;
      }

      case "itemsAdd": {
        ws.serializeAttachment(state);
        if (!state.participant) return send(ws, error("not_joined", "Join the room first.", refOf(message)));
        this.handleItems(ws, state.participant, message);
        return;
      }

      case "claimHost":
        return this.claimHost(ws, state, message.token);

      case "claimVoter":
        return this.claimVoter(ws, state, message.key);

      case "voteSet": {
        ws.serializeAttachment(state);
        if (!state.participant) return send(ws, error("not_joined", "Join the room first.", refOf(message)));
        return this.voteSet(ws, state, message.noteId, message.count);
      }

      case "voteStart":
      case "voteStop":
      case "voteClear": {
        ws.serializeAttachment(state);
        if (!state.participant) return send(ws, error("not_joined", "Join the room first."));
        if (!state.participant.host) return send(ws, error("not_host", "Only the host can do that."));
        return this.handleVoting(ws, message);
      }

      case "lockSet":
      case "timerStart":
      case "timerStop":
      case "endSession": {
        ws.serializeAttachment(state);
        if (!state.participant) return send(ws, error("not_joined", "Join the room first."));
        if (!state.participant.host) return send(ws, error("not_host", "Only the host can do that."));
        return this.handleHost(ws, message);
      }
    }
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
      return send(ws, error("not_joined", "Join the room first."));
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
    send(ws, { type: "hostGranted" });
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
      return send(ws, error("not_joined", "Join the room first."));
    }
    ws.serializeAttachment(state);
    const voterId = await voterIdFor(state.roomId, key, (this.env as Env & Secrets).ROOM_SIGNING_KEY ?? "");
    // Other messages from this socket may have been handled while that was worked out: start from its latest state.
    const latest = readState(ws) ?? state;
    if (this.tombstone !== null || !latest.participant) return;
    if (voterId === null) return send(ws, error("bad_message", "Voting isn't available in this session."));
    const known = this.knownVoters(ws);
    if (!known.has(voterId) && known.size >= MAX_VOTERS_PER_ROUND) {
      return send(ws, error("voters_full", `This round has the maximum of ${MAX_VOTERS_PER_ROUND} voters.`));
    }
    latest.voterId = voterId;
    ws.serializeAttachment(latest);
    send(ws, { type: "voterGranted", remaining: this.remaining(voterId), mine: this.notes.votesOf(voterId) });
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
    if (this.voting.state !== "open") return send(ws, error("voting_closed", "Voting isn't open.", { noteId }));
    const voterId = state.voterId;
    if (!voterId) return send(ws, error("no_voter", "Claim a voter first.", { noteId }));
    if (!this.notes.get(noteId)) return;
    const mine = this.notes.votesOf(voterId);
    const others = mine.reduce((sum, v) => sum + (v.noteId === noteId ? 0 : v.count), 0);
    if (others + count > this.voting.budget) return send(ws, error("over_budget", "That's more dots than you have.", { noteId }));
    // A voter new to this round's votes (a backstop: claimVoter already counts them).
    if (count > 0 && mine.length === 0 && !this.notes.voterIds().has(voterId) && this.notes.voterIds().size >= MAX_VOTERS_PER_ROUND) {
      return send(ws, error("voters_full", `This round has the maximum of ${MAX_VOTERS_PER_ROUND} voters.`, { noteId }));
    }
    this.notes.setVote(voterId, noteId, count);
    const confirmed: ServerMessage = { type: "voteConfirmed", noteId, count, remaining: this.remaining(voterId) };
    for (const socket of this.ctx.getWebSockets()) {
      if (socket.readyState === WebSocket.OPEN && readState(socket)?.voterId === voterId) send(socket, confirmed);
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
          send(ws, { type: "votingChanged", voting: current });
          if (current.state === "closed") send(ws, this.revealed());
          return;
        }
        next = { ...current, state: "closed" };
        break;
      case "voteClear":
        if (current.state === "off" && this.notes.voterIds().size === 0) return send(ws, { type: "votingChanged", voting: current });
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
        if (message.locked === this.locked) return send(ws, { type: "lockChanged", locked: this.locked });
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
        if (!this.timer) return send(ws, { type: "timerChanged", timer: null });
        this.notes.setMeta({ timer_started_at: null, timer_duration_ms: null });
        this.timer = null;
        return this.broadcast({ type: "timerChanged", timer: null });
      }
      case "endSession": {
        // Everyone hears it, the room is buried (step 1 is synchronous, so nothing can be written
        // after it), every socket is closed with 4411, then the rest of the storage goes.
        this.broadcast({ type: "sessionEnded" });
        const tombstone = this.buryNow("ended");
        for (const socket of this.ctx.getWebSockets()) safeClose(socket, ROOM_ENDED_CLOSE_CODE, ENDED_REASON);
        return this.finishBurial(tombstone);
      }
    }
  }

  /**
   * Notes and frames with their full content (protocol v11). Each entry is checked on its own; a
   * message using a ref twice is refused whole. Valid entries fill the room's free note and frame
   * slots in order and the rest are refused (notes_full, frames_full). Text is cleaned and rects
   * clamped as for noteAdd and frameAdd; ids, z, rev (1) and author are the server's. New notes go
   * on top in array order (zForNew, one at a time); a renumbering at the bound is broadcast first
   * as notesOrdered. Everything is written in one transaction and sent as one itemsAdded (refs and
   * refusals only in the sender's copy). Nothing added: no broadcast, only an error to the sender.
   * Content is untrusted text: cleaned, never logged.
   */
  private handleItems(ws: WebSocket, you: Participant, message: ItemsMessage): void {
    const check = checkItems(message.notes, message.frames);
    if (check.duplicate) return send(ws, error("bad_message", "An item is named twice.", refOf(message)));
    const refused: ItemRefusal[] = [...check.invalid];
    const refuse = (kind: ItemRefusal["kind"], index: number, ref: string, reason: ItemRefusal["reason"]) => refused.push({ kind, index, ref, reason });

    // Notes: free slots in order, each on top of the last.
    let stack: Stacked[] = this.notes.all().map(({ id, z }) => ({ id, z }));
    const notes: { ref: string; note: Note }[] = [];
    let noteSlots = MAX_NOTES_PER_ROOM - this.notes.count;
    for (const { index, entry } of check.notes) {
      const text = cleanNoteText(entry.text);
      if (text === null) {
        refuse("note", index, entry.ref, "invalid");
        continue;
      }
      if (noteSlots <= 0) {
        refuse("note", index, entry.ref, "notes_full");
        continue;
      }
      noteSlots--;
      const { ref, x, y, w, h, text: _, ...style } = entry;
      const id = randomBase64url(12);
      const { z, changes } = zForNew(stack);
      if (changes.length > 0) {
        const renumbered = new Map(changes.map((c) => [c.id, c.z]));
        stack = stack.map((s) => ({ id: s.id, z: renumbered.get(s.id) ?? s.z }));
      }
      stack.push({ id, z });
      notes.push({ ref, note: { id, ...clampNoteRect({ x, y, w, h }), text, ...style, z, rev: 1, authorId: you.id } });
    }
    // A renumbering may have moved notes added earlier in this message too: they take their final z.
    const finalZ = new Map(stack.map((s) => [s.id, s.z]));
    for (const added of notes) added.note = { ...added.note, z: finalZ.get(added.note.id) ?? added.note.z };
    const renumbered = this.restacked(stack.filter((s) => this.notes.get(s.id)));

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
    refused.sort((a, b) => (a.kind === b.kind ? a.index - b.index : a.kind === "note" ? -1 : 1));

    if (notes.length === 0 && frames.length === 0) {
      const reasons = new Set(refused.map((r) => r.reason));
      const code: ErrorCode = reasons.size === 1 && !reasons.has("invalid") ? (reasons.has("notes_full") ? "notes_full" : "frames_full") : "bad_message";
      return send(ws, { type: "error", code, message: "Nothing was added.", clientRef: message.clientRef, refused });
    }

    this.notes.applyAdds(
      renumbered,
      notes.map((n) => n.note),
      frames.map((f) => f.frame),
    );
    if (renumbered.length > 0) this.broadcast({ type: "notesOrdered", results: renumbered.map((n) => ({ id: n.id, z: n.z, rev: n.rev })) });
    send(ws, { type: "itemsAdded", clientRef: message.clientRef, notes, frames, refused });
    this.broadcast(
      { type: "itemsAdded", notes: notes.map(({ note }) => ({ note })), frames: frames.map(({ frame }) => ({ frame })), refused: [] },
      ws,
    );
  }

  /**
   * Frames: last-write-wins in arrival order, every stored change bumps rev, unknown or deleted
   * frames are ignored silently. A final frameMove carries the notes it names by the same delta,
   * clamped once for the whole group, in one transaction and one frameMoved (with the notes).
   * Live moves and resizes are relayed to the others, coalesced, never stored. Titles are untrusted
   * text: cleaned, never logged.
   */
  private handleFrame(ws: WebSocket, you: Participant, message: FrameMessage): void {
    switch (message.type) {
      case "frameAdd": {
        if (this.notes.frameCount >= MAX_FRAMES_PER_ROOM) {
          return send(ws, error("frames_full", `This board has the maximum of ${MAX_FRAMES_PER_ROOM} frames.`, refOf(message)));
        }
        const title = cleanFrameTitle(message.title);
        if (title === null) return send(ws, error("bad_message", "Frame title is too long.", refOf(message)));
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
        send(ws, { type: "frameAdded", frame, clientRef: message.clientRef });
        this.broadcast({ type: "frameAdded", frame }, ws);
        return;
      }

      case "frameEdit": {
        const current = this.notes.getFrame(message.id);
        if (!current) return;
        const title = message.title === undefined ? current.title : cleanFrameTitle(message.title);
        if (title === null) return send(ws, error("bad_message", "Frame title is too long.", refOf(message)));
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
        const carried = (message.noteIds ?? []).flatMap((id) => this.notes.get(id) ?? []);
        const target = clampFramePosition(message.x, message.y, current);
        const { dx, dy } = carried.length > 0 ? groupOffset([current, ...carried], target.x - current.x, target.y - current.y) : { dx: target.x - current.x, dy: target.y - current.y };
        const x = current.x + dx;
        const y = current.y + dy;
        const placed = carried.map((note) => ({ note, ...clampNotePosition(note.x + dx, note.y + dy, note) }));
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
        // The frame and every changed note in one transaction: 1 + N rows at most.
        this.notes.applyFrameMove(frame, changed);
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
  private handleOrder(ws: WebSocket, message: OrderMessage): void {
    const { valid, invalid, invalidIds } = checkOrder(message.ids);
    if (invalid.length > 0) {
      send(ws, {
        type: "error",
        code: "bad_message",
        message: "Some notes could not be understood.",
        entries: invalid,
        ...(invalidIds.length > 0 ? { noteIds: invalidIds } : {}),
      });
    }
    const ids = valid.map((v) => v.id).filter((id) => this.notes.get(id));
    if (ids.length === 0) return;
    const { changes } = restack(this.notes.all(), ids, message.action);
    const updates = this.restacked(changes);
    this.notes.applyBatch(updates, []);
    const reported = new Set([...ids, ...updates.map((n) => n.id)]);
    const results = [...reported].flatMap((id) => {
      const note = this.notes.get(id);
      return note ? [{ id, z: note.z, rev: note.rev }] : [];
    });
    this.broadcast({ type: "notesOrdered", results });
  }

  /** Notes with their new z (and a rev bump), from stacking changes. */
  private restacked(changes: readonly Stacked[]): Note[] {
    return changes.flatMap(({ id, z }) => {
      const current = this.notes.get(id);
      return current && current.z !== z ? [{ ...current, z, rev: current.rev + 1 }] : [];
    });
  }

  /**
   * Many moves, resizes and deletes. Each entry is checked on its own: invalid ones are named
   * back to the sender by index (and note id) while the rest apply; a batch naming a note twice
   * is refused whole. Unknown and deleted notes are ignored silently. Final batches are stored
   * in one transaction (one rev bump per changed note) and sent to everyone as one
   * notesBatchApplied; live ones (a group drag) are relayed to the others, coalesced, never stored.
   */
  private handleBatch(ws: WebSocket, message: BatchMessage): void {
    const { valid, invalid, invalidIds } = checkBatch(message.ops);
    if (invalid.length > 0) {
      send(ws, {
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
        const current = this.notes.get(entry.id);
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
    for (const { entry } of valid) {
      const current = this.notes.get(entry.id);
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
  }

  /**
   * Last-write-wins, in arrival order. Every stored change bumps the note's rev.
   * Edits, moves and deletes of an unknown (or already deleted) note are ignored silently.
   * Logging hygiene: nothing here logs note text (or anything else).
   */
  private handleNote(ws: WebSocket, you: Participant, message: NoteMessage): void {
    switch (message.type) {
      case "noteAdd": {
        if (this.notes.count >= MAX_NOTES_PER_ROOM) {
          return send(ws, error("notes_full", `This board has the maximum of ${MAX_NOTES_PER_ROOM} notes.`, refOf(message)));
        }
        const text = cleanNoteText(message.text);
        if (text === null) return send(ws, error("bad_message", "Note text is too long.", refOf(message)));
        // A new note goes on top. At the bound the others are renumbered first, and everyone hears.
        const stack = zForNew(this.notes.all());
        const renumbered = this.restacked(stack.changes);
        if (renumbered.length > 0) {
          this.notes.applyBatch(renumbered, []);
          this.broadcast({ type: "notesOrdered", results: renumbered.map((n) => ({ id: n.id, z: n.z, rev: n.rev })) });
        }
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
        this.notes.insert(note);
        send(ws, { type: "noteAdded", note, clientRef: message.clientRef });
        this.broadcast({ type: "noteAdded", note }, ws);
        return;
      }

      case "noteEdit": {
        const current = this.notes.get(message.id);
        if (!current) return;
        let next: Note = current;
        if (message.text !== undefined) {
          const text = cleanNoteText(message.text);
          if (text === null) return send(ws, error("bad_message", "Note text is too long.", refOf(message)));
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
        const current = this.notes.get(message.id);
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
        const current = this.notes.get(message.id);
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
        if (!this.notes.get(message.id)) return;
        this.notes.delete(message.id);
        this.broadcast({ type: "noteDeleted", id: message.id });
        return;
      }
    }
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

  /** Joined participants on open sockets, in connection order. */
  private participants(): { ws: WebSocket; participant: Participant }[] {
    return this.ctx.getWebSockets().flatMap((ws) => {
      if (ws.readyState !== WebSocket.OPEN) return [];
      const participant = readState(ws)?.participant;
      return participant ? [{ ws, participant }] : [];
    });
  }

  private broadcast(message: ServerMessage, except?: WebSocket): void {
    const raw = encodeMessage(message);
    for (const { ws } of this.participants()) if (ws !== except) send(ws, raw);
  }

  /** Forget the socket's participant and tell everyone else. Safe to call twice. */
  private leave(ws: WebSocket, state: SocketState): void {
    const left = state.participant;
    if (!left) return;
    state.participant = null;
    try {
      ws.serializeAttachment(state);
    } catch {
      // The socket is already gone; it no longer counts as open either way.
    }
    this.broadcast({ type: "participant_left", id: left.id }, ws);
  }
}

/** Entries a message spends from BATCH_LIMITS: batch ops, restack ids, the notes a final frame move carries, and added items. */
export function entriesOf(message: ClientMessage): number {
  switch (message.type) {
    case "itemsAdd":
      return (message.notes?.length ?? 0) + (message.frames?.length ?? 0);
    case "noteBatch":
      return message.ops.length;
    case "notesOrder":
      return message.ids.length;
    case "frameMove":
      return message.final ? (message.noteIds?.length ?? 0) : 0;
    default:
      return 0;
  }
}

function readState(ws: WebSocket): SocketState | null {
  const parsed = socketStateSchema.safeParse(ws.deserializeAttachment());
  return parsed.success ? parsed.data : null;
}

function send(ws: WebSocket, message: ServerMessage | string): void {
  try {
    ws.send(typeof message === "string" ? message : encodeMessage(message));
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
