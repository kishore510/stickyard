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
  NOTE_DEFAULTS,
  NOTE_EDIT_FIELDS,
  PROTOCOL_VERSION,
  ROOM_EXPIRED_CLOSE_CODE,
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
} from "@stickyard/shared";
import { z } from "zod";
import { randomBase64url } from "./crypto";
import { EXPIRED_REASON, nextExpiryAlarm, readTombstone, writeTombstone } from "./expiry";
import { BATCH_LIMITS, SOCKET_LIMITS } from "./limits";
import { NoteStore } from "./noteStore";

/**
 * Per-socket state, kept in the WebSocket attachment so it survives hibernation.
 * Notes and frames live in the room's SQLite (see noteStore.ts); nothing about people is stored.
 */
const socketStateSchema = z.object({
  /** Said hello with our protocol version. */
  hello: z.boolean(),
  /** Set once joined. Server-assigned; never taken from a message. */
  participant: participantSchema.nullable(),
  /** Token bucket. */
  tokens: z.number(),
  at: z.number(),
  /** Over-limit messages since `strikeAt` (the start of the current violation window). */
  strikes: z.number().int(),
  strikeAt: z.number(),
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
  /** The notes and frames; null once the room has expired (nothing may read or write them). */
  private store: NoteStore | null;
  /** When the room expired (its tombstone), or null. */
  private expiredAt: number | null;
  /** Rows written outside the current store: alarm sets, the tombstone, and a store dropped at expiry. */
  private otherRows = 0;
  /** Non-final moves and resizes waiting to be relayed, latest per note and kind. Never stored. */
  private readonly pendingMoves = new Map<string, Pending>();
  /** Frames' live moves and resizes, likewise. */
  private readonly pendingFrames = new Map<string, PendingFrame>();
  private flushScheduled = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // An expired room never runs the normal init: that would create a fresh board under the tombstone.
    this.expiredAt = readTombstone(ctx.storage.sql);
    this.store = this.expiredAt === null ? new NoteStore(ctx.storage.sql, (fn) => ctx.storage.transactionSync(fn)) : null;
  }

  /** Only reached from joined sockets, which an expired room never has (see fetch and webSocketMessage). */
  private get notes(): NoteStore {
    if (!this.store) throw new Error("room expired");
    return this.store;
  }

  /**
   * Rows written by this instance (tests check drags write nothing). Counts an alarm set as one
   * row, as Cloudflare bills it.
   */
  get rowsWritten(): number {
    return this.otherRows + (this.store?.rowsWritten ?? 0);
  }

  /** The room has expired (it has a tombstone). */
  get expired(): boolean {
    return this.expiredAt !== null;
  }

  /** Batch transactions committed by this instance (tests check a final batch is one). */
  get transactions(): number {
    return this.store?.transactions ?? 0;
  }

  override async fetch(_request: Request): Promise<Response> {
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    if (this.expiredAt !== null) {
      // Room links stay validly signed, so this close is how a visitor learns the room has gone.
      safeClose(pair[1], ROOM_EXPIRED_CLOSE_CODE, EXPIRED_REASON);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    const state: SocketState = {
      hello: false,
      participant: null,
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

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (this.expiredAt !== null) {
      safeClose(ws, ROOM_EXPIRED_CLOSE_CODE, EXPIRED_REASON);
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
    this.handle(ws, state, parsed.value);
  }

  /**
   * A message over a rate budget is dropped with rate_limited (naming its notes). Violations are
   * counted per window, not consecutively, so a sender at twice the rate still gets closed.
   */
  private async overLimit(ws: WebSocket, state: SocketState, now: number, ref: ErrorRef): Promise<void> {
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
    send(ws, error("rate_limited", "Slow down a little.", ref));
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
    if (this.expiredAt !== null) return;
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
   * written; the next last close sets a new alarm. Otherwise everything goes (deleteAll, which
   * at our compatibility date also deletes the alarm), the in-memory state is dropped so this
   * instance can't serve old notes, and then the tombstone is written (after deleteAll, which
   * would remove it). Already expired: nothing to do.
   */
  override async alarm(): Promise<void> {
    if (this.expiredAt !== null || this.openSockets() > 0) return;
    await this.ctx.storage.deleteAll();
    this.otherRows += this.store?.rowsWritten ?? 0;
    this.store = null;
    this.pendingMoves.clear();
    this.pendingFrames.clear();
    const at = Date.now();
    this.otherRows += writeTombstone(this.ctx.storage.sql, at);
    this.expiredAt = at;
  }

  private handle(ws: WebSocket, state: SocketState, message: ClientMessage): void {
    // Anything other than a drag or resize in progress relays pending ones first, so everyone
    // sees changes in arrival order.
    if (!isPreview(message)) this.flushMoves();

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

        send(ws, { type: "joined", you, participants: this.participants().map(({ participant }) => participant), locked: false, timer: null });
        // Notes, then frames, in this same step: nothing else can be sent to this socket between them.
        send(ws, { type: "snapshot", notes: this.notes.all() });
        send(ws, { type: "framesSnapshot", frames: this.notes.allFrames() });
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
