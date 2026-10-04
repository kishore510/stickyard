import { z } from "zod";

/*
 * HTTP API between the web app and the Worker (everything that isn't the WebSocket).
 */

/** Cap on the create passcode, in characters. */
export const MAX_PASSCODE_LENGTH = 256;
/** Cap on the POST /rooms body, in bytes. */
export const MAX_CREATE_BODY_BYTES = 1024;

/** A room code is `<id>.<sig>`: 16 random bytes and a 128-bit HMAC, each base64url without padding. */
const ROOM_CODE = /^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}$/;
export const ROOM_CODE_LENGTH = 45;

/** Shape only. Says nothing about whether the signature is valid; only the Worker can check that. */
export function isRoomCodeShape(code: string): boolean {
  return code.length === ROOM_CODE_LENGTH && ROOM_CODE.test(code);
}

export const roomCodeSchema = z.string().refine(isRoomCodeShape);

/** POST /rooms body. The passcode travels only here, never in a URL or header. */
export const createRoomRequestSchema = z.strictObject({
  passcode: z.string().min(1).max(MAX_PASSCODE_LENGTH),
});

/**
 * POST /rooms answer. `hostToken` (protocol v12) proves its holder created the room: the web keeps
 * it on the creator's device and sends it only in claimHost. Never in a URL.
 */
export const createRoomResponseSchema = z.object({ code: roomCodeSchema, hostToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });

export const apiErrorCodeSchema = z.enum([
  "invalid_passcode",
  "rate_limited",
  "creation_disabled",
  "not_configured",
  "bad_request",
  "too_large",
  "forbidden_origin",
  "not_found",
]);
export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;

export const apiErrorSchema = z.object({ error: apiErrorCodeSchema });
export type ApiError = z.infer<typeof apiErrorSchema>;

/** GET /health */
export const healthResponseSchema = z.object({
  ok: z.literal(true),
  protocolVersion: z.number().int().nonnegative(),
});

/** GET /rooms/check?room=<code>: 200 for a validly signed code, 404 otherwise. */
export const roomCheckResponseSchema = z.object({ ok: z.literal(true) });
