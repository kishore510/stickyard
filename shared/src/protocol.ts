import { z } from "zod";

/** Bump on any wire-format change, with compatibility handling and tests. */
export const PROTOCOL_VERSION = 1;

/** Hard cap on a single WebSocket message, in UTF-8 bytes. Checked before JSON.parse. */
export const MAX_MESSAGE_BYTES = 4096;

const protocolVersion = z.number().int().nonnegative();

// Non-strict on purpose: a future client may add fields to `hello`, and we still
// want to read its protocolVersion so we can answer `version_mismatch`.
export const helloSchema = z.object({
  type: z.literal("hello"),
  protocolVersion,
});

export const clientMessageSchema = z.discriminatedUnion("type", [helloSchema]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

export const errorCodeSchema = z.enum(["version_mismatch", "bad_message", "too_large", "rate_limited"]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

export const welcomeSchema = z.object({
  type: z.literal("welcome"),
  protocolVersion,
});

export const errorMessageSchema = z.object({
  type: z.literal("error"),
  code: errorCodeSchema,
  message: z.string().max(500),
});

export const serverMessageSchema = z.discriminatedUnion("type", [welcomeSchema, errorMessageSchema]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;
