import { DurableObject } from "cloudflare:workers";
import {
  MAX_PARTICIPANTS,
  PROTOCOL_VERSION,
  clientMessageSchema,
  cleanName,
  cleanText,
  encodeMessage,
  parseMessage,
  participantSchema,
  type ClientMessage,
  type ErrorCode,
  type Participant,
  type ServerMessage,
} from "@stickyard/shared";
import { z } from "zod";
import { randomBase64url } from "./crypto";
import { SOCKET_LIMITS } from "./limits";

/**
 * Per-socket state, kept in the WebSocket attachment so it survives hibernation.
 * Nothing is written to storage: an empty room stores nothing (persistence is slice 5).
 */
const socketStateSchema = z.object({
  /** Said hello with our protocol version. */
  hello: z.boolean(),
  /** Set once joined. Server-assigned; never taken from a message. */
  participant: participantSchema.nullable(),
  /** Token bucket. */
  tokens: z.number(),
  at: z.number(),
  /** Consecutive over-limit messages. */
  strikes: z.number().int(),
});
type SocketState = z.infer<typeof socketStateSchema>;

const error = (code: ErrorCode, message: string): ServerMessage => ({ type: "error", code, message });

/**
 * One instance per room, addressed by the room id from a verified code.
 * Uses the WebSocket Hibernation API so idle rooms don't stay in memory. The participant
 * list is derived from the live sockets' attachments.
 */
export class Room extends DurableObject<Env> {
  override async fetch(_request: Request): Promise<Response> {
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    const state: SocketState = { hello: false, participant: null, tokens: SOCKET_LIMITS.burst, at: Date.now(), strikes: 0 };
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
      state.strikes += 1;
      if (state.strikes >= SOCKET_LIMITS.maxViolations) {
        this.leave(ws, state);
        safeClose(ws, 1008, "Too many messages");
        return;
      }
      ws.serializeAttachment(state);
      send(ws, error("rate_limited", "Slow down a little."));
      return;
    }
    state.tokens -= 1;
    state.strikes = 0;

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
