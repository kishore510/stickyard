import { DurableObject } from "cloudflare:workers";
import {
  MAX_NOTES_PER_ROOM,
  MAX_PARTICIPANTS,
  NOTE_DEFAULTS,
  NOTE_EDIT_FIELDS,
  PROTOCOL_VERSION,
  clampNotePosition,
  clampNoteRect,
  clientMessageSchema,
  cleanName,
  cleanNoteText,
  cleanText,
  encodeMessage,
  parseMessage,
  participantSchema,
  type ClientMessage,
  type ErrorCode,
  type Note,
  type Participant,
  type ServerMessage,
} from "@stickyard/shared";
import { z } from "zod";
import { randomBase64url } from "./crypto";
import { SOCKET_LIMITS } from "./limits";
import { NoteStore } from "./noteStore";

/**
 * Per-socket state, kept in the WebSocket attachment so it survives hibernation.
 * Notes live in the room's SQLite (see noteStore.ts); nothing about people is stored.
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
});
type SocketState = z.infer<typeof socketStateSchema>;

/** Which note (or pending add) an error is about, so the sender can roll back. */
type ErrorRef = { clientRef: string } | { noteId: string } | Record<string, never>;

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
    default:
      return {};
  }
}

type NoteMessage = Extract<ClientMessage, { type: "noteAdd" | "noteEdit" | "noteMove" | "noteResize" | "noteDelete" }>;

/** Drags and resizes in progress: relayed (coalesced), never stored. */
const isPreview = (message: ClientMessage) => (message.type === "noteMove" || message.type === "noteResize") && !message.final;

/**
 * One instance per room, addressed by the room id from a verified code.
 * Uses the WebSocket Hibernation API so idle rooms don't stay in memory. The participant
 * list is derived from the live sockets' attachments.
 */
export class Room extends DurableObject<Env> {
  private readonly notes: NoteStore;
  /** Non-final moves and resizes waiting to be relayed, latest per note and kind. Never stored. */
  private readonly pendingMoves = new Map<string, { from: WebSocket; message: ServerMessage }>();
  private flushScheduled = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.notes = new NoteStore(ctx.storage.sql);
  }

  /** SQLite rows written by this instance (tests check drags write nothing). */
  get rowsWritten(): number {
    return this.notes.rowsWritten;
  }

  override async fetch(_request: Request): Promise<Response> {
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    const state: SocketState = {
      hello: false,
      participant: null,
      tokens: SOCKET_LIMITS.burst,
      at: Date.now(),
      strikes: 0,
      strikeAt: 0,
    };
    pair[1].serializeAttachment(state);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
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
      // Counted per window, not consecutively: a sender at twice the rate still gets closed.
      if (now - state.strikeAt > SOCKET_LIMITS.violationWindowMs) {
        state.strikes = 0;
        state.strikeAt = now;
      }
      state.strikes += 1;
      if (state.strikes >= SOCKET_LIMITS.maxViolations) {
        this.leave(ws, state);
        safeClose(ws, 1008, "Too many messages");
        return;
      }
      ws.serializeAttachment(state);
      // The message is dropped. Name the note it was about (if any) so the sender can roll back.
      const dropped = parseMessage(message, clientMessageSchema);
      send(ws, error("rate_limited", "Slow down a little.", dropped.ok ? refOf(dropped.value) : {}));
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
    this.handle(ws, state, parsed.value);
  }

  override async webSocketClose(ws: WebSocket, code: number, _reason: string, _wasClean: boolean): Promise<void> {
    const state = readState(ws);
    if (state) this.leave(ws, state);
    // 1005/1006 are reserved and cannot be sent back in a close frame.
    safeClose(ws, code === 1005 || code === 1006 ? 1000 : code, "closing");
  }

  override async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    const state = readState(ws);
    if (state) this.leave(ws, state);
    safeClose(ws, 1011, "error");
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
        const you: Participant = { id: randomBase64url(12), name, colourIndex };
        state.participant = you;
        ws.serializeAttachment(state);

        send(ws, { type: "joined", you, participants: this.participants().map(({ participant }) => participant) });
        send(ws, { type: "snapshot", notes: this.notes.all() });
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
    }
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
        // The id, rev and author are the server's; the author comes from this socket.
        // A new note has the default size and style; noteAdd carries neither.
        const note: Note = {
          id: randomBase64url(12),
          ...NOTE_DEFAULTS,
          ...clampNotePosition(message.x, message.y),
          text,
          color: message.color,
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
    if (this.pendingMoves.size === 0) return;
    const pending = [...this.pendingMoves.values()];
    this.pendingMoves.clear();
    for (const { from, message } of pending) {
      // A note deleted since then is not moved or resized.
      if ((message.type === "noteMoved" || message.type === "noteResized") && !this.notes.get(message.id)) continue;
      this.broadcast(message, from);
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
