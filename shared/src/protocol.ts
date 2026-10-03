import { z } from "zod";
import { cleanName, cleanNoteText, cleanText, codePointLength } from "./clean";

/**
 * Bump on any wire-format change, with compatibility handling and tests.
 * v1 (slice 0): hello/welcome only. v2 (slice 1): rooms, join, say/echo.
 * v3 (slice 2): shared notes (snapshot, noteAdd/Edit/Move/Delete), refs on errors.
 */
export const PROTOCOL_VERSION = 3;

/** Hard cap on a single client-to-server WebSocket message, in UTF-8 bytes. Checked before JSON.parse. */
export const MAX_MESSAGE_BYTES = 4096;
/**
 * Cap the client applies to server messages. Bigger than MAX_MESSAGE_BYTES because a
 * snapshot carries every note (a test checks the largest possible one fits).
 */
export const MAX_SERVER_MESSAGE_BYTES = 512 * 1024;

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

/* ── Notes ──────────────────────────────────────────────────────────── */

/** Notes on one board. */
export const MAX_NOTES_PER_ROOM = 200;
/** Note text length after cleaning, in characters. */
export const MAX_NOTE_TEXT = 280;
/**
 * The board is a fixed area measured in board units (1 unit = 1 CSS pixel at the default scale).
 * A note's x, y is its top-left corner; the server clamps it so the whole note stays on the board.
 * The web mirrors these in tokens.css (a test checks).
 */
export const BOARD_WIDTH = 3200;
export const BOARD_HEIGHT = 2000;
export const NOTE_SIZE = 160;

/** Note colours are palette keys, never colour values. The web maps each to a design token. */
export const NOTE_COLORS = ["yellow", "pink", "blue", "green", "orange", "purple"] as const;
export const noteColorSchema = z.enum(NOTE_COLORS);
export type NoteColor = z.infer<typeof noteColorSchema>;

/** Rounds and clamps a position so the whole note is on the board. */
export function clampNotePosition(x: number, y: number): { x: number; y: number } {
  const clamp = (value: number, max: number) => Math.min(max, Math.max(0, Math.round(Number.isFinite(value) ? value : 0)));
  return { x: clamp(x, BOARD_WIDTH - NOTE_SIZE), y: clamp(y, BOARD_HEIGHT - NOTE_SIZE) };
}

/** Server-assigned id (participants and notes): 12 random bytes, base64url. */
const serverIdSchema = z.string().regex(/^[A-Za-z0-9_-]{16}$/);
export const noteIdSchema = serverIdSchema;
/** The sender's temporary id for an add, so it can swap in the server id. Echoed only to the sender. */
export const clientRefSchema = z.string().regex(/^[A-Za-z0-9_-]{1,32}$/);

/** Integer board coordinates. Out-of-range values are refused; the server then clamps to the note size. */
const boardX = z.number().int().min(0).max(BOARD_WIDTH);
const boardY = z.number().int().min(0).max(BOARD_HEIGHT);
/** Inbound note text: at most MAX_NOTE_TEXT characters (the server still cleans it). */
const noteTextIn = z
  .string()
  .max(MAX_NOTE_TEXT * 2)
  .refine((text) => codePointLength(text) <= MAX_NOTE_TEXT);

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

// Note messages are strict: a claimed id, rev or author is refused, not silently dropped.
export const noteAddSchema = z.strictObject({
  type: z.literal("noteAdd"),
  clientRef: clientRefSchema,
  x: boardX,
  y: boardY,
  color: noteColorSchema,
  text: noteTextIn,
});

export const noteEditSchema = z.strictObject({
  type: z.literal("noteEdit"),
  id: noteIdSchema,
  text: noteTextIn,
});

/** final=false while dragging (relayed, never stored); final=true on drop (stored, bumps rev). */
export const noteMoveSchema = z.strictObject({
  type: z.literal("noteMove"),
  id: noteIdSchema,
  x: boardX,
  y: boardY,
  final: z.boolean(),
});

export const noteDeleteSchema = z.strictObject({
  type: z.literal("noteDelete"),
  id: noteIdSchema,
});

export const clientMessageSchema = z.discriminatedUnion("type", [
  helloSchema,
  joinSchema,
  saySchema,
  noteAddSchema,
  noteEditSchema,
  noteMoveSchema,
  noteDeleteSchema,
]);
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
  "notes_full",
]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

/** Server-assigned participant id: 12 random bytes, base64url. */
export const participantIdSchema = serverIdSchema;

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
  /** The refused noteAdd's clientRef, so the sender can roll it back. */
  clientRef: clientRefSchema.optional(),
  /** The note a refused edit, move or delete was about, so the sender can roll it back. */
  noteId: noteIdSchema.optional(),
});

/** A note as the server stores and sends it. Text is already clean; anything else is rejected. */
export const noteSchema = z.object({
  id: noteIdSchema,
  x: z.number().int().min(0).max(BOARD_WIDTH - NOTE_SIZE),
  y: z.number().int().min(0).max(BOARD_HEIGHT - NOTE_SIZE),
  text: z.string().refine((text) => cleanNoteText(text) === text),
  color: noteColorSchema,
  /** Server-assigned; starts at 1 and goes up by one on every stored change. */
  rev: z.number().int().min(1),
  /** The participant who added it, from their socket. Participant ids are per visit. */
  authorId: participantIdSchema,
});
export type Note = z.infer<typeof noteSchema>;

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

/** Every note on the board, in creation order. Sent right after `joined`. */
export const snapshotSchema = z.object({
  type: z.literal("snapshot"),
  notes: z.array(noteSchema).max(MAX_NOTES_PER_ROOM),
});

export const noteAddedSchema = z.object({
  type: z.literal("noteAdded"),
  note: noteSchema,
  /** Only in the copy sent to the note's sender. */
  clientRef: clientRefSchema.optional(),
});

/** Text changed. */
export const noteUpdatedSchema = z.object({
  type: z.literal("noteUpdated"),
  note: noteSchema,
});

/** Non-final moves go to everyone but the mover and carry the current rev; final ones bump it. */
export const noteMovedSchema = z.object({
  type: z.literal("noteMoved"),
  id: noteIdSchema,
  x: noteSchema.shape.x,
  y: noteSchema.shape.y,
  rev: noteSchema.shape.rev,
  final: z.boolean(),
});

export const noteDeletedSchema = z.object({
  type: z.literal("noteDeleted"),
  id: noteIdSchema,
});

export const serverMessageSchema = z.discriminatedUnion("type", [
  welcomeSchema,
  errorMessageSchema,
  joinedSchema,
  participantJoinedSchema,
  participantLeftSchema,
  echoSchema,
  snapshotSchema,
  noteAddedSchema,
  noteUpdatedSchema,
  noteMovedSchema,
  noteDeletedSchema,
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;
