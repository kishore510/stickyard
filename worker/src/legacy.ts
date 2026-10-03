import { PROTOCOL_VERSION, clientMessageSchema, encodeMessage, parseMessage, type ServerMessage } from "@stickyard/shared";

/**
 * Compatibility for pages from before protocol v2, which open `/ws` with no room code and
 * send `hello`. Answered here in the Worker, without any Durable Object: one reply, then close.
 * An old page gets `version_mismatch` and shows "please reload"; anything else gets `bad_message`.
 */
export function legacySocket(): Response {
  const pair = new WebSocketPair();
  const server = pair[1];
  server.accept();
  server.addEventListener("message", (event) => {
    const parsed = parseMessage(event.data, clientMessageSchema);
    const reply: ServerMessage =
      parsed.ok && parsed.value.type === "hello" && parsed.value.protocolVersion !== PROTOCOL_VERSION
        ? { type: "error", code: "version_mismatch", message: `Server speaks protocol v${PROTOCOL_VERSION}. Please reload.` }
        : { type: "error", code: "bad_message", message: "Open a session link to join a room." };
    try {
      server.send(encodeMessage(reply));
      server.close(1000, "done");
    } catch {
      // Already closed.
    }
  });
  return new Response(null, { status: 101, webSocket: pair[0] });
}
