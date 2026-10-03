import { z } from "zod";
import { cleanName, cleanText } from "./clean";

/**
 * Bump on any wire-format change, with compatibility handling and tests.
 * v1 (slice 0): hello/welcome only. v2 (slice 1): rooms, join, say/echo.
 */
export const PROTOCOL_VERSION = 2;

/** Hard cap on a single WebSocket message, in UTF-8 bytes. Checked before JSON.parse. */
export const MAX_MESSAGE_BYTES = 4096;

/** Display name length after cleaning, in characters. */
export const MAX_NAME_LENGTH = 24;
/** Echo text length after cleaning, in characters. */
export const MAX_TEXT_LENGTH = 280;
/** People in one room. The project owner's chosen default; change it here. */
export const MAX_PARTICIPANTS = 20;
/** Participant colours in the design tokens (`--sy-participant-1..N`). colourIndex maps onto them modulo this. */
export const PALETTE_SIZE = 8;

/*
 * Raw (uncleaned) caps on inbound strings. Generous, so a name that is too long only after
 * cleaning gets `invalid_name` rather than `bad_message`; the message size cap bounds them anyway.
 */
const RAW_NAME_MAX = 200;
const RAW_TEXT_MAX = 2000;

const protocolVersion = z.number().int().nonnegative();

// Non-strict on purpose: a future client may add fields to `hello`, and we still
// want to read its protocolVersion so we can answer `version_mismatch`.
export const helloSchema = z.object({
  type: z.literal("hello"),
  protocolVersion,
});

// Unknown keys (a claimed id, colour or sender) are stripped: the server decides those.
export const joinSchema = z.object({
  type: z.literal("join"),
  name: z.string().max(RAW_NAME_MAX),
});

export const saySchema = z.object({
  type: z.literal("say"),
  text: z.string().max(RAW_TEXT_MAX),
});

export const clientMessageSchema = z.discriminatedUnion("type", [helloSchema, joinSchema, saySchema]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

export const errorCodeSchema = z.enum([
  "version_mismatch",
  "bad_message",
  "too_large",
  "rate_limited",
  "room_full",
  "not_joined",
  "already_joined",
  "invalid_name",
]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

/** Server-assigned participant id: 12 random bytes, base64url. */
export const participantIdSchema = z.string().regex(/^[A-Za-z0-9_-]{16}$/);

/** What the server sends about a person. Names are already clean; anything else is rejected. */
export const participantSchema = z.object({
  id: participantIdSchema,
  name: z.string().refine((name) => cleanName(name) === name),
  colourIndex: z.number().int().min(0).max(MAX_PARTICIPANTS - 1),
});
export type Participant = z.infer<typeof participantSchema>;

export const welcomeSchema = z.object({
  type: z.literal("welcome"),
  protocolVersion,
});

export const errorMessageSchema = z.object({
  type: z.literal("error"),
  code: errorCodeSchema,
  message: z.string().max(500),
});

export const joinedSchema = z.object({
  type: z.literal("joined"),
  you: participantSchema,
  participants: z.array(participantSchema).max(MAX_PARTICIPANTS),
});

export const participantJoinedSchema = z.object({
  type: z.literal("participant_joined"),
  participant: participantSchema,
});

export const participantLeftSchema = z.object({
  type: z.literal("participant_left"),
  id: participantIdSchema,
});

export const echoSchema = z.object({
  type: z.literal("echo"),
  /** Set by the server from the sending socket, never from the message. */
  from: participantIdSchema,
  text: z.string().refine((text) => cleanText(text) === text),
});

export const serverMessageSchema = z.discriminatedUnion("type", [
  welcomeSchema,
  errorMessageSchema,
  joinedSchema,
  participantJoinedSchema,
  participantLeftSchema,
  echoSchema,
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;
