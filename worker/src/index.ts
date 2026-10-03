import { PROTOCOL_VERSION } from "@stickyard/shared";
import { isAllowedOrigin, parseAllowedOrigins } from "./origin";

export { Room } from "./room";
export { Limiter } from "./limiter";

// Slice 0 routes every socket to one fixed object. Real room routing arrives in slice 1.
const PLACEHOLDER_ROOM = "check";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, protocolVersion: PROTOCOL_VERSION });
    }

    if (request.method === "GET" && url.pathname === "/ws") {
      // Checked before upgrading. See origin.ts for what this does and does not protect against.
      if (!isAllowedOrigin(request.headers.get("Origin"), parseAllowedOrigins(env.ALLOWED_ORIGINS))) {
        return new Response("Forbidden origin", { status: 403 });
      }
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return new Response("Expected WebSocket upgrade", { status: 426 });
      }
      return env.ROOM.getByName(PLACEHOLDER_ROOM).fetch(request);
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
