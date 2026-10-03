import { MAX_CREATE_BODY_BYTES, PROTOCOL_VERSION, createRoomRequestSchema } from "@stickyard/shared";
import { safeEqual } from "./crypto";
import { creationEnabled, readConfig, type WorkerEnv } from "./env";
import { apiError, corsHeaders, json, notFound, readCappedBody } from "./http";
import { legacySocket } from "./legacy";
import { LIMITER_NAME, clientKey } from "./limiter";
import { isAllowedOrigin, parseAllowedOrigins } from "./origin";
import { createRoomCode, verifyRoomCode } from "./roomCode";

export { Room } from "./room";
export { Limiter } from "./limiter";

/*
 * Logging hygiene: nothing in the Worker logs request bodies, names, text, passcodes,
 * room codes or IP addresses (test/logging.test.ts forbids console logging outright).
 */

/** The request's Origin if it is on the allow-list (see origin.ts for what that does and does not stop). */
function allowedOrigin(request: Request, env: WorkerEnv): string | null {
  const origin = request.headers.get("Origin");
  return isAllowedOrigin(origin, parseAllowedOrigins(env.ALLOWED_ORIGINS)) ? origin : null;
}

async function createRoom(request: Request, env: WorkerEnv, origin: string): Promise<Response> {
  const cors = corsHeaders(origin);
  const config = readConfig(env);
  if (!config.ok) return apiError("not_configured", 503, cors);
  if (!creationEnabled(env)) return apiError("creation_disabled", 503, cors);

  const raw = await readCappedBody(request, MAX_CREATE_BODY_BYTES);
  if (raw === null) return apiError("too_large", 413, cors);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return apiError("bad_request", 400, cors);
  }
  const parsed = createRoomRequestSchema.safeParse(body);
  if (!parsed.success) return apiError("bad_request", 400, cors);

  const passcodeOk = await safeEqual(parsed.data.passcode, config.passcode);
  const client = await clientKey(request.headers.get("CF-Connecting-IP") ?? "unknown", config.signingKey);
  const decision = await env.LIMITER.getByName(LIMITER_NAME).attempt(client, passcodeOk, Date.now());

  switch (decision.outcome) {
    case "created":
      return json({ code: await createRoomCode(config.signingKey) }, 200, cors);
    case "invalid":
      return apiError("invalid_passcode", 401, cors);
    case "limited":
      return apiError("rate_limited", 429, { ...cors, "retry-after": String(decision.retryAfterSeconds) });
  }
}

async function checkRoom(url: URL, env: WorkerEnv, origin: string): Promise<Response> {
  const cors = corsHeaders(origin);
  const config = readConfig(env);
  if (!config.ok) return apiError("not_configured", 503, cors);
  const id = await verifyRoomCode(url.searchParams.get("room"), config.signingKey);
  return id ? json({ ok: true }, 200, cors) : apiError("not_found", 404, cors);
}

async function openSocket(request: Request, url: URL, env: WorkerEnv): Promise<Response> {
  if (!allowedOrigin(request, env)) return new Response("Forbidden origin", { status: 403 });
  const isUpgrade = request.headers.get("Upgrade")?.toLowerCase() === "websocket";

  // No room code at all: an old (protocol v1) page. Never reaches a Durable Object.
  if (!url.searchParams.has("room")) {
    return isUpgrade ? legacySocket() : new Response("Expected WebSocket upgrade", { status: 426 });
  }

  const config = readConfig(env);
  if (!config.ok) return new Response("Not available", { status: 503 });
  // The signature is checked before any Durable Object is addressed.
  const id = await verifyRoomCode(url.searchParams.get("room"), config.signingKey);
  if (!id) return notFound();
  if (!isUpgrade) return new Response("Expected WebSocket upgrade", { status: 426 });
  return env.ROOM.get(env.ROOM.idFromName(id)).fetch(request);
}

export default {
  async fetch(request, env, _ctx): Promise<Response> {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;

    if (route === "GET /health") {
      return json({ ok: true, protocolVersion: PROTOCOL_VERSION }, 200, corsHeaders(allowedOrigin(request, env)));
    }

    if (route === "GET /ws") return openSocket(request, url, env);

    if (url.pathname === "/rooms" || url.pathname === "/rooms/check") {
      const origin = allowedOrigin(request, env);
      if (request.method === "OPTIONS") {
        if (!origin) return new Response(null, { status: 403 });
        return new Response(null, {
          status: 204,
          headers: {
            ...corsHeaders(origin),
            "access-control-allow-methods": "GET, POST",
            "access-control-allow-headers": "content-type",
            "access-control-max-age": "600",
          },
        });
      }
      if (route === "POST /rooms") return origin ? createRoom(request, env, origin) : apiError("forbidden_origin", 403);
      if (route === "GET /rooms/check") return origin ? checkRoom(url, env, origin) : apiError("forbidden_origin", 403);
    }

    return notFound();
  },
} satisfies ExportedHandler<WorkerEnv>;
