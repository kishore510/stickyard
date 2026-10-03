import { z } from "zod";
import { cleanName, cleanNoteText, cleanText, codePointLength } from "./clean";

/**
 * Bump on any wire-format change, with compatibility handling and tests.
 * v1 (slice 0): hello/welcome only. v2 (slice 1): rooms, join, say/echo.
 * v3 (slice 2): shared notes (snapshot, noteAdd/Edit/Move/Delete), refs on errors.
 * v4 (slice 2.7): note size (noteResize/noteResized), colour change and text style (noteEdit fields).
 * v5 (slice 2.7.1): titleAlign, the title's (first line's) own alignment; `align` is the body's.
 * v6 (slice 2.7.2): titleFontSize, titleBold, titleItalic, titleTextColor; fontSize, bold,
 *   italic and textColor are now the body's.
 */
export const PROTOCOL_VERSION = 6;

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
 * A note's x, y is its top-left corner and w, h its size; the server clamps so the whole note
 * stays on the board. The web mirrors these in tokens.css (a test checks).
 */
export const BOARD_WIDTH = 3200;
export const BOARD_HEIGHT = 2000;
/** A new note's size. */
export const NOTE_DEFAULT_W = 160;
export const NOTE_DEFAULT_H = 160;
/** Resize limits (both enforced by the server; the web stops the handles there too). */
export const NOTE_MIN_W = 96;
export const NOTE_MIN_H = 96;
export const NOTE_MAX_W = 480;
export const NOTE_MAX_H = 480;

/** Note colours are palette keys, never colour values. The web maps each to a design token. */
export const NOTE_COLORS = ["yellow", "pink", "blue", "green", "orange", "purple"] as const;
export const noteColorSchema = z.enum(NOTE_COLORS);
export type NoteColor = z.infer<typeof noteColorSchema>;

/*
 * Text style: keys, never CSS values. The title (first line) and the body (the rest) each have
 * their own; a style applies to the whole of its part (plain text, no inline markup). The web
 * maps each key to a design token.
 */
export const NOTE_FONT_SIZES = ["s", "m", "l", "xl"] as const;
export const noteFontSizeSchema = z.enum(NOTE_FONT_SIZES);
export type NoteFontSize = z.infer<typeof noteFontSizeSchema>;
/** "auto" is the note's usual readable foreground. */
export const NOTE_TEXT_COLORS = ["auto", "red", "orange", "green", "blue", "purple", "grey"] as const;
export const noteTextColorSchema = z.enum(NOTE_TEXT_COLORS);
export type NoteTextColor = z.infer<typeof noteTextColorSchema>;
export const NOTE_ALIGNS = ["left", "center", "right"] as const;
export const noteAlignSchema = z.enum(NOTE_ALIGNS);
export type NoteAlign = z.infer<typeof noteAlignSchema>;

/**
 * What a new note gets (noteAdd carries none of these), and what the storage migrations fill in
 * for older rows (the title fields then copy the body's). The title starts like the body.
 */
export const NOTE_DEFAULTS = {
  w: NOTE_DEFAULT_W,
  h: NOTE_DEFAULT_H,
  fontSize: "m",
  bold: false,
  italic: false,
  textColor: "auto",
  align: "left",
  titleAlign: "left",
  titleFontSize: "m",
  titleBold: false,
  titleItalic: false,
  titleTextColor: "auto",
} as const satisfies {
  w: number;
  h: number;
  fontSize: NoteFontSize;
  bold: boolean;
  italic: boolean;
  textColor: NoteTextColor;
  align: NoteAlign;
  titleAlign: NoteAlign;
  titleFontSize: NoteFontSize;
  titleBold: boolean;
  titleItalic: boolean;
  titleTextColor: NoteTextColor;
};

export interface NoteRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const whole = (value: number, fallback: number) => (Number.isFinite(value) ? Math.round(value) : fallback);
const between = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value));

/** Rounds and clamps a position so the whole note (default size unless given) is on the board. */
export function clampNotePosition(
  x: number,
  y: number,
  size: { w: number; h: number } = NOTE_DEFAULTS,
): { x: number; y: number } {
  return {
    x: between(whole(x, 0), 0, BOARD_WIDTH - size.w),
    y: between(whole(y, 0), 0, BOARD_HEIGHT - size.h),
  };
}

/** Size first (whole units, within min/max), then position (the whole note on the board). */
export function clampNoteRect(rect: NoteRect): NoteRect {
  const w = between(whole(rect.w, NOTE_DEFAULT_W), NOTE_MIN_W, NOTE_MAX_W);
  const h = between(whole(rect.h, NOTE_DEFAULT_H), NOTE_MIN_H, NOTE_MAX_H);
  return { ...clampNotePosition(rect.x, rect.y, { w, h }), w, h };
}

/** Server-assigned id (participants and notes): 12 random bytes, base64url. */
const serverIdSchema = z.string().regex(/^[A-Za-z0-9_-]{16}$/);
export const noteIdSchema = serverIdSchema;
/** The sender's temporary id for an add, so it can swap in the server id. Echoed only to the sender. */
export const clientRefSchema = z.string().regex(/^[A-Za-z0-9_-]{1,32}$/);

/** Integer board coordinates. Out-of-range values are refused; the server then clamps to the note size. */
const boardX = z.number().int().min(0).max(BOARD_WIDTH);
const boardY = z.number().int().min(0).max(BOARD_HEIGHT);
const noteW = z.number().int().min(NOTE_MIN_W).max(NOTE_MAX_W);
const noteH = z.number().int().min(NOTE_MIN_H).max(NOTE_MAX_H);
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

/** The fields a noteEdit may change. Everything but id is optional; at least one must be there. */
export const NOTE_EDIT_FIELDS = [
  "text",
  "color",
  "fontSize",
  "bold",
  "italic",
  "textColor",
  "align",
  "titleAlign",
  "titleFontSize",
  "titleBold",
  "titleItalic",
  "titleTextColor",
] as const;
type NoteStyleField = Exclude<(typeof NOTE_EDIT_FIELDS)[number], "text">;
/** The style fields (colour, and each part's text style): every noteEdit field but text. */
export const NOTE_STYLE_FIELDS: readonly NoteStyleField[] = NOTE_EDIT_FIELDS.filter((f): f is NoteStyleField => f !== "text");

export const noteEditSchema = z
  .strictObject({
    type: z.literal("noteEdit"),
    id: noteIdSchema,
    text: noteTextIn.optional(),
    color: noteColorSchema.optional(),
    fontSize: noteFontSizeSchema.optional(),
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    textColor: noteTextColorSchema.optional(),
    align: noteAlignSchema.optional(),
    titleAlign: noteAlignSchema.optional(),
    titleFontSize: noteFontSizeSchema.optional(),
    titleBold: z.boolean().optional(),
    titleItalic: z.boolean().optional(),
    titleTextColor: noteTextColorSchema.optional(),
  })
  .refine((edit) => NOTE_EDIT_FIELDS.some((field) => edit[field] !== undefined), { message: "Nothing to change." });

/** final=false while dragging (relayed, never stored); final=true on drop (stored, bumps rev). */
export const noteMoveSchema = z.strictObject({
  type: z.literal("noteMove"),
  id: noteIdSchema,
  x: boardX,
  y: boardY,
  final: z.boolean(),
});

/**
 * Position and size together (a top or left handle moves the note too), applied atomically.
 * final=false while resizing (relayed, never stored); final=true on release (stored, bumps rev).
 */
export const noteResizeSchema = z.strictObject({
  type: z.literal("noteResize"),
  id: noteIdSchema,
  x: boardX,
  y: boardY,
  w: noteW,
  h: noteH,
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
  noteResizeSchema,
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

/** The whole note on the board at its size. */
const onBoard = (n: NoteRect) => n.x + n.w <= BOARD_WIDTH && n.y + n.h <= BOARD_HEIGHT;

/** A note as the server stores and sends it. Text is already clean; anything else is rejected. */
export const noteSchema = z.object({
  id: noteIdSchema,
  x: z.number().int().min(0).max(BOARD_WIDTH - NOTE_MIN_W),
  y: z.number().int().min(0).max(BOARD_HEIGHT - NOTE_MIN_H),
  w: noteW,
  h: noteH,
  text: z.string().refine((text) => cleanNoteText(text) === text),
  color: noteColorSchema,
  /** The body's (every line after the first) size, weight, slant, ink and alignment. */
  fontSize: noteFontSizeSchema,
  bold: z.boolean(),
  italic: z.boolean(),
  textColor: noteTextColorSchema,
  align: noteAlignSchema,
  /** The title's (first line's) own size, weight, slant, ink and alignment. */
  titleFontSize: noteFontSizeSchema,
  titleBold: z.boolean(),
  titleItalic: z.boolean(),
  titleTextColor: noteTextColorSchema,
  titleAlign: noteAlignSchema,
  /** Server-assigned; starts at 1 and goes up by one on every stored change. */
  rev: z.number().int().min(1),
  /** The participant who added it, from their socket. Participant ids are per visit. */
  authorId: participantIdSchema,
}).refine(onBoard);
export type Note = z.infer<typeof noteSchema>;
/** The style fields of a note (what noteEdit can change besides text). */
export type NoteStyle = Pick<Note, NoteStyleField>;

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

/** Text, colour or style changed. Carries the whole note. */
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

/** Like noteMoved, with the size: non-final ones go to everyone but the resizer at the current rev. */
export const noteResizedSchema = z
  .object({
    type: z.literal("noteResized"),
    id: noteIdSchema,
    x: noteSchema.shape.x,
    y: noteSchema.shape.y,
    w: noteW,
    h: noteH,
    rev: noteSchema.shape.rev,
    final: z.boolean(),
  })
  .refine(onBoard);

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
  noteResizedSchema,
  noteDeletedSchema,
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;
