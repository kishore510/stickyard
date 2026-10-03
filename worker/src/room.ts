import { DurableObject } from "cloudflare:workers";
import { encodeMessage } from "@stickyard/shared";
import { handleClientFrame } from "./handshake";

/**
 * One instance per room (slice 0: a single placeholder instance).
 * Uses the WebSocket Hibernation API so idle sockets don't keep the object in memory.
 */
export class Room extends DurableObject<Env> {
  override async fetch(_request: Request): Promise<Response> {
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    ws.send(encodeMessage(handleClientFrame(message)));
  }

  override async webSocketClose(ws: WebSocket, code: number, _reason: string, _wasClean: boolean): Promise<void> {
    // 1005/1006 are reserved and cannot be sent back in a close frame.
    ws.close(code === 1005 || code === 1006 ? 1000 : code, "closing");
  }

  override async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    ws.close(1011, "error");
  }
}
