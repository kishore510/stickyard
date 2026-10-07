import { z } from "zod";
import { cleanFrameTitle, cleanName, cleanNoteText, cleanShapeText, cleanText, codePointLength } from "./clean";
import { NOTE_Z_LIMIT, ORDER_ACTIONS } from "./stack";

/**
 * Bump on any wire-format change, with compatibility handling and tests.
 * v1 (slice 0): hello/welcome only. v2 (slice 1): rooms, join, say/echo.
 * v3 (slice 2): shared notes (snapshot, noteAdd/Edit/Move/Delete), refs on errors.
 * v4 (slice 2.7): note size (noteResize/noteResized), colour change and text style (noteEdit fields).
 * v5 (slice 2.7.1): titleAlign, the title's (first line's) own alignment; `align` is the body's.
 * v6 (slice 2.7.2): titleFontSize, titleBold, titleItalic, titleTextColor; fontSize, bold,
 *   italic and textColor are now the body's.
 * v7 (slice 2.8): noteBatch (many moves, resizes and deletes in one message), notesBatchApplied,
 *   and errors that name refused batch entries (entries, noteIds).
 * v8 (slice z-order): notes carry z (stacking order, server-assigned); notesOrder (bring to
 *   front, send to back) and notesOrdered.
 * v9 (slice frames): frames (frameAdd/Edit/Move/Resize/Delete and their server messages); a
 *   final frameMove may carry notes; joining sends snapshot (notes, unchanged) then framesSnapshot.
 * v10 (slice frame title styling): frames carry titleFontSize, titleBold, titleItalic,
 *   titleTextColor and titleAlign (the note key sets), also optional frameEdit fields.
 * v11 (slice create with content): itemsAdd (notes and frames with their full content in one
 *   message) and itemsAdded; errors may carry `refused` (which items, and why).
 * v12 (slice host): a host token from room creation (claimHost/hostGranted, participants carry
 *   `host`, participantUpdated), the board lock (lockSet/lockChanged, board_locked refusals), a
 *   timer (timerStart/timerStop/timerChanged), End session (endSession/sessionEnded, close code
 *   4411); `joined` carries `locked` and `timer`.
 * v13 (dot voting): claimVoter/voterGranted (an anonymous voter from a client-made random key),
 *   voteStart/voteStop/voteClear (host only) and votingChanged, voteSet/voteConfirmed (to the
 *   voter's own sockets only), votesRevealed (totals, once closed); `joined` carries `voting`.
 * v14 (live cursors): cursor / cursorLeft from a page, cursorMoved / cursorGone (to the others
 *   only, the id from the sender's socket). Relayed live, never stored.
 * v15 (text and shapes): shapes (text labels, rectangles, ovals, diamonds: shapeAdd/Edit/Move/
 *   Resize/Delete, shapeBatch and their server messages); joining sends shapesSnapshot right after
 *   framesSnapshot; shapes share the notes' stacking space (notesOrder may name shapes, and
 *   notesOrdered may report them); frameMove may carry shapes (shapeIds) and frameMoved reports
 *   them; itemsAdd may carry shapes, and note and shape items may give a `rank`.
 */
export const PROTOCOL_VERSION = 15;

/**
 * Hard cap on a single client-to-server WebSocket message, in UTF-8 bytes. Checked before JSON.parse.
 * A full noteBatch (50 resize entries at their longest) fits too, so it isn't raised (test checks).
 */
export const MAX_MESSAGE_BYTES = 4096;
/**
 * Cap the client applies to server messages. Bigger than MAX_MESSAGE_BYTES because a
 * snapshot carries every note (a test checks the largest possible one fits).
 */
export const MAX_SERVER_MESSAGE_BYTES = 512 * 1024;

/**
 * Idle room expiry (not a protocol message, so no version bump). A room nobody has been in for
 * this many days is deleted by its Durable Object's alarm; joining it afterwards gets a socket
 * that is closed at once with ROOM_EXPIRED_CLOSE_CODE (reason "expired"). The web treats that
 * code, and only it, as final: no retries, no Rejoin.
 */
export const ROOM_IDLE_EXPIRY_DAYS = 7;
export const ROOM_EXPIRED_CLOSE_CODE = 4410;
/**
 * A host ended the session (protocol v12): every socket is closed with this code (reason
 * "ended"), the room's data is deleted, and later joins are accepted and closed with it at once.
 * Final for the web, like 4410.
 */
export const ROOM_ENDED_CLOSE_CODE = 4411;

/** Timer durations a host may start (protocol v12): 1 second to 3 hours. Outside: refused (bad_message). */
export const TIMER_MIN_MS = 1000;
export const TIMER_MAX_MS = 3 * 60 * 60 * 1000;

/**
 * Dot voting (protocol v13). Each voter has `budget` dots a round (VOTE_BUDGET_MIN to
 * VOTE_BUDGET_MAX; outside is refused, not clamped) to spread over notes, several on one note and
 * on their own notes allowed. A voter is a client-made random key (VOTER_KEY_MIN_LENGTH to
 * VOTER_KEY_MAX_LENGTH base64url characters, 128 random bits from the web); the relay keeps only
 * an HMAC of it. At most MAX_VOTERS_PER_ROUND voters a round (beyond: voters_full).
 */
export const VOTE_BUDGET_MIN = 1;
export const VOTE_BUDGET_MAX = 20;
export const VOTE_BUDGET_DEFAULT = 5;
export const MAX_VOTERS_PER_ROUND = 40;
export const VOTER_KEY_MIN_LENGTH = 22;
export const VOTER_KEY_MAX_LENGTH = 64;
/** off: no round (no votes); open: voting (anonymous, no live totals); closed: totals revealed. */
export const VOTING_STATES = ["off", "open", "closed"] as const;
export type VotingStateName = (typeof VOTING_STATES)[number];

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

/* ── Frames (v9) ────────────────────────────────────────────────────── */

/** Frames on one board. */
export const MAX_FRAMES_PER_ROOM = 30;
/** Frame title length after cleaning, in characters (one line; may be empty). */
export const MAX_FRAME_TITLE = 60;
/** Frames are bigger than notes; the server clamps so the whole frame stays on the board. Mirrored in tokens.css (a test checks). */
export const FRAME_DEFAULT_W = 640;
export const FRAME_DEFAULT_H = 400;
export const FRAME_MIN_W = 240;
export const FRAME_MIN_H = 160;
export const FRAME_MAX_W = 2400;
export const FRAME_MAX_H = 1600;

/** Frame colours are keys, never colour values: neutral plus the six note hues. The web maps each to tokens. */
export const FRAME_COLORS = ["neutral", "yellow", "pink", "blue", "green", "orange", "purple"] as const;
export const frameColorSchema = z.enum(FRAME_COLORS);
export type FrameColor = z.infer<typeof frameColorSchema>;

/**
 * A frame title's style (v10): the note key sets, keys only. What a new frame gets (frameAdd
 * carries none) and what storage fills in for older rows. Together they look like the v9 header:
 * medium, bold (drawn semibold), upright, the usual ink, left.
 */
export const FRAME_DEFAULTS = {
  titleFontSize: "m",
  titleBold: true,
  titleItalic: false,
  titleTextColor: "auto",
  titleAlign: "left",
} as const satisfies {
  titleFontSize: NoteFontSize;
  titleBold: boolean;
  titleItalic: boolean;
  titleTextColor: NoteTextColor;
  titleAlign: NoteAlign;
};

/** The frame title style fields. */
export const FRAME_STYLE_FIELDS = ["titleFontSize", "titleBold", "titleItalic", "titleTextColor", "titleAlign"] as const;
/** The fields a frameEdit may change. Everything but id is optional; at least one must be there. */
export const FRAME_EDIT_FIELDS = ["title", "color", ...FRAME_STYLE_FIELDS] as const;
export type FrameEditField = (typeof FRAME_EDIT_FIELDS)[number];

/** Rounds and clamps a position so the whole frame (default size unless given) is on the board. */
export function clampFramePosition(
  x: number,
  y: number,
  size: { w: number; h: number } = { w: FRAME_DEFAULT_W, h: FRAME_DEFAULT_H },
): { x: number; y: number } {
  return clampNotePosition(x, y, size);
}

/** Size first (whole units, within the frame min/max), then position (the whole frame on the board). */
export function clampFrameRect(rect: NoteRect): NoteRect {
  const w = between(whole(rect.w, FRAME_DEFAULT_W), FRAME_MIN_W, FRAME_MAX_W);
  const h = between(whole(rect.h, FRAME_DEFAULT_H), FRAME_MIN_H, FRAME_MAX_H);
  return { ...clampFramePosition(rect.x, rect.y, { w, h }), w, h };
}

/**
 * A group move's offset (whole units), clamped once for the whole group so the arrangement is
 * kept at the board's edges: a multi-selection drag on the page, and a frame carrying its notes
 * on both sides. Each member may still be clamped on its own as a backstop.
 */
export function groupOffset(rects: readonly NoteRect[], dx: number, dy: number): { dx: number; dy: number } {
  if (rects.length === 0) return { dx: 0, dy: 0 };
  const left = Math.min(...rects.map((r) => r.x));
  const top = Math.min(...rects.map((r) => r.y));
  const right = Math.max(...rects.map((r) => r.x + r.w));
  const bottom = Math.max(...rects.map((r) => r.y + r.h));
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, whole(v, 0)));
  return { dx: clamp(dx, -left, BOARD_WIDTH - right), dy: clamp(dy, -top, BOARD_HEIGHT - bottom) };
}

/* ── Shapes (v15) ────────────────────────────────────────────────────── */

/**
 * A shape's kind, fixed when it is made. A text label is a shape with no fill and no border by
 * default (it can be given either later).
 */
export const SHAPE_KINDS = ["text", "rect", "oval", "diamond"] as const;
export const shapeKindSchema = z.enum(SHAPE_KINDS);
export type ShapeKind = z.infer<typeof shapeKindSchema>;
/** Shapes on one board. */
export const MAX_SHAPES_PER_ROOM = 50;
/** Shape text length after cleaning, in characters (line breaks kept; may be empty). */
export const MAX_SHAPE_TEXT = 500;
/** Resize limits for every kind (the server clamps; mirrored in tokens.css, a test checks). */
export const SHAPE_MIN_W = 40;
export const SHAPE_MIN_H = 24;
export const SHAPE_MAX_W = 2400;
export const SHAPE_MAX_H = 1600;

/** Fills: none, or neutral plus the six note hues. Keys, never colour values. */
export const SHAPE_FILLS = ["none", ...FRAME_COLORS] as const;
export const shapeFillSchema = z.enum(SHAPE_FILLS);
export type ShapeFill = z.infer<typeof shapeFillSchema>;
/** Border colours: neutral plus the six note hues (no border = strokeWidth none). */
export const SHAPE_STROKES = FRAME_COLORS;
export const shapeStrokeSchema = frameColorSchema;
export type ShapeStroke = FrameColor;
export const SHAPE_STROKE_WIDTHS = ["none", "thin", "medium", "thick"] as const;
export const shapeStrokeWidthSchema = z.enum(SHAPE_STROKE_WIDTHS);
export type ShapeStrokeWidth = z.infer<typeof shapeStrokeWidthSchema>;
export const SHAPE_STROKE_STYLES = ["solid", "dashed"] as const;
export const shapeStrokeStyleSchema = z.enum(SHAPE_STROKE_STYLES);
export type ShapeStrokeStyle = z.infer<typeof shapeStrokeStyleSchema>;
/** Seven text sizes, from small to heading sizes (wider than notes). */
export const SHAPE_FONT_SIZES = ["s", "m", "l", "xl", "2xl", "3xl", "4xl"] as const;
export const shapeFontSizeSchema = z.enum(SHAPE_FONT_SIZES);
export type ShapeFontSize = z.infer<typeof shapeFontSizeSchema>;
/** Each size in CSS pixels; tokens.css mirrors them as --sy-shape-font-<key> (a test checks). */
export const SHAPE_FONT_PX: Readonly<Record<ShapeFontSize, number>> = { s: 12, m: 14, l: 18, xl: 24, "2xl": 32, "3xl": 40, "4xl": 56 };
export const SHAPE_VALIGNS = ["top", "middle", "bottom"] as const;
export const shapeValignSchema = z.enum(SHAPE_VALIGNS);
export type ShapeValign = z.infer<typeof shapeValignSchema>;

/** The style fields a shape has (every shapeEdit field but text). */
export const SHAPE_STYLE_FIELDS = ["fill", "stroke", "strokeWidth", "strokeStyle", "fontSize", "bold", "italic", "underline", "textColor", "align", "valign"] as const;
export type ShapeStyleField = (typeof SHAPE_STYLE_FIELDS)[number];
/** The fields a shapeEdit may change. Everything but id is optional; at least one must be there. Never the kind. */
export const SHAPE_EDIT_FIELDS = ["text", ...SHAPE_STYLE_FIELDS] as const;
export type ShapeEditField = (typeof SHAPE_EDIT_FIELDS)[number];

export interface ShapeStyle {
  fill: ShapeFill;
  stroke: ShapeStroke;
  strokeWidth: ShapeStrokeWidth;
  strokeStyle: ShapeStrokeStyle;
  fontSize: ShapeFontSize;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  textColor: NoteTextColor;
  align: NoteAlign;
  valign: ShapeValign;
}

const BOXED_STYLE: ShapeStyle = {
  fill: "neutral",
  stroke: "neutral",
  strokeWidth: "thin",
  strokeStyle: "solid",
  fontSize: "m",
  bold: false,
  italic: false,
  underline: false,
  textColor: "auto",
  align: "center",
  valign: "middle",
};
const SHAPE_DEFAULTS: Readonly<Record<ShapeKind, ShapeStyle & { w: number; h: number }>> = {
  text: { ...BOXED_STYLE, w: 240, h: 48, fill: "none", strokeWidth: "none", fontSize: "l", align: "left", valign: "top" },
  rect: { ...BOXED_STYLE, w: 200, h: 120 },
  oval: { ...BOXED_STYLE, w: 200, h: 120 },
  diamond: { ...BOXED_STYLE, w: 200, h: 160 },
};

/** A new shape's size and style for its kind (shapeAdd carries neither). Storage fills in the rectangle's for missing columns. */
export function shapeDefaults(kind: ShapeKind): ShapeStyle & { w: number; h: number } {
  return { ...SHAPE_DEFAULTS[kind] };
}

/** Rounds and clamps a position so the whole shape (its size) is on the board. */
export function clampShapePosition(x: number, y: number, size: { w: number; h: number }): { x: number; y: number } {
  return clampNotePosition(x, y, size);
}

/** Size first (whole units, within the shape min/max), then position (the whole shape on the board). */
export function clampShapeRect(rect: NoteRect): NoteRect {
  const w = between(whole(rect.w, SHAPE_DEFAULTS.rect.w), SHAPE_MIN_W, SHAPE_MAX_W);
  const h = between(whole(rect.h, SHAPE_DEFAULTS.rect.h), SHAPE_MIN_H, SHAPE_MAX_H);
  return { ...clampShapePosition(rect.x, rect.y, { w, h }), w, h };
}

/** Server-assigned id (participants, notes, frames and shapes): 12 random bytes, base64url. */
const serverIdSchema = z.string().regex(/^[A-Za-z0-9_-]{16}$/);
export const noteIdSchema = serverIdSchema;
export const shapeIdSchema = serverIdSchema;
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

/**
 * Each note style field's inbound schema: keys only, never CSS. The one list noteEdit (all
 * optional) and itemsAdd's note entries (all required) are built from; the type check keeps it
 * in step with NOTE_STYLE_FIELDS.
 */
const noteStyleShape = {
  color: noteColorSchema,
  fontSize: noteFontSizeSchema,
  bold: z.boolean(),
  italic: z.boolean(),
  textColor: noteTextColorSchema,
  align: noteAlignSchema,
  titleAlign: noteAlignSchema,
  titleFontSize: noteFontSizeSchema,
  titleBold: z.boolean(),
  titleItalic: z.boolean(),
  titleTextColor: noteTextColorSchema,
} satisfies Record<NoteStyleField, z.ZodType>;

export const noteEditSchema = z
  .strictObject({
    type: z.literal("noteEdit"),
    id: noteIdSchema,
    text: noteTextIn.optional(),
    ...z.object(noteStyleShape).partial().shape,
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

/* ── Batches (v7) ───────────────────────────────────────────────────── */

/** Entries in one noteBatch. A selection with more is sent in chunks of this many (not atomic across chunks). */
export const MAX_BATCH_ENTRIES = 50;

/** One change in a batch, strict like the single-note messages. Values are clamped by the server. */
export const noteBatchEntrySchema = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("move"), id: noteIdSchema, x: boardX, y: boardY }),
  z.strictObject({ op: z.literal("resize"), id: noteIdSchema, x: boardX, y: boardY, w: noteW, h: noteH }),
  z.strictObject({ op: z.literal("delete"), id: noteIdSchema }),
]);
export type NoteBatchEntry = z.infer<typeof noteBatchEntrySchema>;

/**
 * Many moves, resizes or deletes at once. The envelope is strict; entries are checked one by one
 * (checkBatch), so the server can apply the good ones and name the bad ones by index.
 * final=false is a group drag in progress (relayed, never stored); final=true is stored, in one
 * transaction. Send entries typed as NoteBatchEntry.
 */
export const noteBatchSchema = z.strictObject({
  type: z.literal("noteBatch"),
  ops: z.array(z.unknown()).min(1).max(MAX_BATCH_ENTRIES),
  final: z.boolean(),
});

export interface BatchCheck {
  valid: { index: number; entry: NoteBatchEntry }[];
  /** Indexes of refused entries, in order. */
  invalid: number[];
  /** The note ids of refused entries that had a readable id, so the sender can roll them back. */
  invalidIds: string[];
  /** Some note appears twice: the whole batch is refused. */
  duplicate: boolean;
}

const readableId = (op: unknown): string | null => {
  if (typeof op !== "object" || op === null || !("id" in op)) return null;
  const parsed = noteIdSchema.safeParse(op.id);
  return parsed.success ? parsed.data : null;
};

/** Checks each entry of a batch. A batch that names any note twice is refused whole. */
export function checkBatch(ops: readonly unknown[]): BatchCheck {
  return checkOps(ops, noteBatchEntrySchema);
}

interface OpsCheck<T> {
  valid: { index: number; entry: T }[];
  invalid: number[];
  invalidIds: string[];
  duplicate: boolean;
}

function checkOps<T>(ops: readonly unknown[], schema: z.ZodType<T>): OpsCheck<T> {
  const ids = ops.map(readableId);
  const named = ids.filter((id): id is string => id !== null);
  const duplicate = new Set(named).size !== named.length;
  const uniqueIds = (indexes: number[]) => [...new Set(indexes.map((i) => ids[i]).filter((id): id is string => id != null))];
  if (duplicate) {
    const all = ops.map((_, i) => i);
    return { valid: [], invalid: all, invalidIds: uniqueIds(all), duplicate };
  }
  const valid: OpsCheck<T>["valid"] = [];
  const invalid: number[] = [];
  ops.forEach((op, index) => {
    const parsed = schema.safeParse(op);
    if (parsed.success) valid.push({ index, entry: parsed.data });
    else invalid.push(index);
  });
  return { valid, invalid, invalidIds: uniqueIds(invalid), duplicate };
}

/* ── Stacking order (v8) ────────────────────────────────────────────── */

/**
 * Brings notes to the front or sends them to the back, keeping their order among themselves.
 * Since v15 the ids may name shapes too: notes and shapes share one stacking space.
 * The envelope is strict; ids are checked one by one (checkOrder), so bad ones are named by
 * index while the rest apply. A selection with more notes is sent in chunks of
 * MAX_BATCH_ENTRIES, in stacking order (see RoomSession.orderNotes). Send ids as strings.
 */
export const notesOrderSchema = z.strictObject({
  type: z.literal("notesOrder"),
  ids: z.array(z.unknown()).min(1).max(MAX_BATCH_ENTRIES),
  action: z.enum(ORDER_ACTIONS),
});

export interface OrderCheck {
  valid: { index: number; id: string }[];
  /** Indexes of refused ids, in order. */
  invalid: number[];
  /** The readable ids of a refused message (all of them when an id is named twice). */
  invalidIds: string[];
  /** Some note appears twice: the whole message is refused. */
  duplicate: boolean;
}

/** Checks each id of a notesOrder. A message that names any note twice is refused whole. */
export function checkOrder(ids: readonly unknown[]): OrderCheck {
  const readable = ids.map((value) => {
    const parsed = noteIdSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  });
  const named = readable.filter((id): id is string => id !== null);
  if (new Set(named).size !== named.length) {
    return { valid: [], invalid: ids.map((_, i) => i), invalidIds: [...new Set(named)], duplicate: true };
  }
  const valid: OrderCheck["valid"] = [];
  const invalid: number[] = [];
  readable.forEach((id, index) => (id === null ? invalid.push(index) : valid.push({ index, id })));
  return { valid, invalid, invalidIds: [], duplicate: false };
}

/* ── Frame messages (v9) ────────────────────────────────────────────── */

export const frameIdSchema = serverIdSchema;
const frameW = z.number().int().min(FRAME_MIN_W).max(FRAME_MAX_W);
const frameH = z.number().int().min(FRAME_MIN_H).max(FRAME_MAX_H);
/** Inbound frame title: at most MAX_FRAME_TITLE characters (the server still cleans it to one line). */
const frameTitleIn = z
  .string()
  .max(MAX_FRAME_TITLE * 4)
  .refine((title) => codePointLength(title) <= MAX_FRAME_TITLE);

/** A new frame at a position (top-left), default size; no id, size or author (the server's). */
export const frameAddSchema = z.strictObject({
  type: z.literal("frameAdd"),
  clientRef: clientRefSchema,
  x: boardX,
  y: boardY,
  color: frameColorSchema,
  title: frameTitleIn,
});

/** A frame title's style fields: the note title's schemas (the same key sets), for frameEdit and itemsAdd. */
const frameStyleShape = {
  titleFontSize: noteStyleShape.titleFontSize,
  titleBold: noteStyleShape.titleBold,
  titleItalic: noteStyleShape.titleItalic,
  titleTextColor: noteStyleShape.titleTextColor,
  titleAlign: noteStyleShape.titleAlign,
} satisfies Record<(typeof FRAME_STYLE_FIELDS)[number], z.ZodType>;

export const frameEditSchema = z
  .strictObject({
    type: z.literal("frameEdit"),
    id: frameIdSchema,
    title: frameTitleIn.optional(),
    color: frameColorSchema.optional(),
    ...z.object(frameStyleShape).partial().shape,
  })
  .refine((edit) => FRAME_EDIT_FIELDS.some((field) => edit[field] !== undefined), { message: "Nothing to change." });

/**
 * A frame's new position. `noteIds` names the notes it carries (computed by the sender when the
 * drag starts: notes whose centre is inside the frame), and since v15 `shapeIds` the shapes: they
 * move by the same delta, clamped once for the whole group. Without them (Alt, or more than
 * MAX_BATCH_ENTRIES inside, notes and shapes together) the frame moves
 * alone. final=false while dragging (relayed, never stored); final=true is stored in one transaction.
 */
export const frameMoveSchema = z.strictObject({
  type: z.literal("frameMove"),
  id: frameIdSchema,
  x: boardX,
  y: boardY,
  final: z.boolean(),
  noteIds: z
    .array(noteIdSchema)
    .max(MAX_BATCH_ENTRIES)
    .refine((ids) => new Set(ids).size === ids.length, { message: "A note is named twice." })
    .optional(),
  /** Since v15: the shapes it carries (centre inside), like noteIds. Notes and shapes share the cap. */
  shapeIds: z
    .array(shapeIdSchema)
    .max(MAX_BATCH_ENTRIES)
    .refine((ids) => new Set(ids).size === ids.length, { message: "A shape is named twice." })
    .optional(),
}).refine((m) => (m.noteIds?.length ?? 0) + (m.shapeIds?.length ?? 0) <= MAX_BATCH_ENTRIES, { message: "At most 50 carried items." });

export const frameResizeSchema = z.strictObject({
  type: z.literal("frameResize"),
  id: frameIdSchema,
  x: boardX,
  y: boardY,
  w: frameW,
  h: frameH,
  final: z.boolean(),
});

export const frameDeleteSchema = z.strictObject({
  type: z.literal("frameDelete"),
  id: frameIdSchema,
});

/* ── Shape messages (v15) ───────────────────────────────────────────── */

const shapeW = z.number().int().min(SHAPE_MIN_W).max(SHAPE_MAX_W);
const shapeH = z.number().int().min(SHAPE_MIN_H).max(SHAPE_MAX_H);
/** Inbound shape text: at most MAX_SHAPE_TEXT characters (the server still cleans it). */
const shapeTextIn = z
  .string()
  .max(MAX_SHAPE_TEXT * 2)
  .refine((text) => codePointLength(text) <= MAX_SHAPE_TEXT);

/** Each shape style field's inbound schema: keys only, never CSS. shapeEdit (optional) and itemsAdd (required) use it. */
const shapeStyleShape = {
  fill: shapeFillSchema,
  stroke: shapeStrokeSchema,
  strokeWidth: shapeStrokeWidthSchema,
  strokeStyle: shapeStrokeStyleSchema,
  fontSize: shapeFontSizeSchema,
  bold: z.boolean(),
  italic: z.boolean(),
  underline: z.boolean(),
  textColor: noteTextColorSchema,
  align: noteAlignSchema,
  valign: shapeValignSchema,
} satisfies Record<ShapeStyleField, z.ZodType>;

/** A new shape of a kind at a position (top-left), with its kind's default size and style and no text. */
export const shapeAddSchema = z.strictObject({
  type: z.literal("shapeAdd"),
  clientRef: clientRefSchema,
  kind: shapeKindSchema,
  x: boardX,
  y: boardY,
});

export const shapeEditSchema = z
  .strictObject({
    type: z.literal("shapeEdit"),
    id: shapeIdSchema,
    text: shapeTextIn.optional(),
    ...z.object(shapeStyleShape).partial().shape,
  })
  .refine((edit) => SHAPE_EDIT_FIELDS.some((field) => edit[field] !== undefined), { message: "Nothing to change." });

/** final=false while dragging (relayed, never stored); final=true on drop (stored, bumps rev). */
export const shapeMoveSchema = z.strictObject({
  type: z.literal("shapeMove"),
  id: shapeIdSchema,
  x: boardX,
  y: boardY,
  final: z.boolean(),
});

export const shapeResizeSchema = z.strictObject({
  type: z.literal("shapeResize"),
  id: shapeIdSchema,
  x: boardX,
  y: boardY,
  w: shapeW,
  h: shapeH,
  final: z.boolean(),
});

export const shapeDeleteSchema = z.strictObject({
  type: z.literal("shapeDelete"),
  id: shapeIdSchema,
});

/** One change in a shapeBatch: noteBatch's entries at shape sizes. */
export const shapeBatchEntrySchema = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("move"), id: shapeIdSchema, x: boardX, y: boardY }),
  z.strictObject({ op: z.literal("resize"), id: shapeIdSchema, x: boardX, y: boardY, w: shapeW, h: shapeH }),
  z.strictObject({ op: z.literal("delete"), id: shapeIdSchema }),
]);
export type ShapeBatchEntry = z.infer<typeof shapeBatchEntrySchema>;

/**
 * Many shape moves, resizes or deletes at once, exactly like noteBatch: a strict envelope with
 * entries checked one by one (checkShapeBatch); final=true stored in one transaction, final=false
 * a group drag (relayed to the others, coalesced, never stored; deletes ignored).
 */
export const shapeBatchSchema = z.strictObject({
  type: z.literal("shapeBatch"),
  ops: z.array(z.unknown()).min(1).max(MAX_BATCH_ENTRIES),
  final: z.boolean(),
});

export interface ShapeBatchCheck {
  valid: { index: number; entry: ShapeBatchEntry }[];
  invalid: number[];
  /** The shape ids of refused entries that had a readable id. */
  invalidIds: string[];
  /** Some shape appears twice: the whole batch is refused. */
  duplicate: boolean;
}

/** Checks each entry of a shapeBatch. A batch that names any shape twice is refused whole. */
export function checkShapeBatch(ops: readonly unknown[]): ShapeBatchCheck {
  return checkOps(ops, shapeBatchEntrySchema);
}


/* ── Create with content (v11) ──────────────────────────────────────── */

/**
 * An item's ref: the sender's name for one entry of an itemsAdd, unique within the message (the
 * web uses a random one per item, unique in its visit). Echoed only to the sender.
 */
export const itemRefSchema = clientRefSchema;

/**
 * Since v15: an item's place among the new notes and shapes of its message, bottom first (they
 * share one stacking space). Items without one go after those with one: notes, then shapes, each
 * in array order.
 */
const itemRank = z.number().int().min(0).max(MAX_BATCH_ENTRIES - 1);

/** A note with its full content. No id, rev, z or author: the server assigns them. Clamped and cleaned by the server. */
export const noteItemSchema = z.strictObject({
  ref: itemRefSchema,
  rank: itemRank.optional(),
  x: boardX,
  y: boardY,
  w: noteW,
  h: noteH,
  text: noteTextIn,
  ...noteStyleShape,
});
export type NoteItem = z.infer<typeof noteItemSchema>;

/** A frame with its full content (size, title, colour, title style). No id, rev or author. */
export const frameItemSchema = z.strictObject({
  ref: itemRefSchema,
  x: boardX,
  y: boardY,
  w: frameW,
  h: frameH,
  title: frameTitleIn,
  color: frameColorSchema,
  ...frameStyleShape,
});
export type FrameItem = z.infer<typeof frameItemSchema>;

/** A shape with its full content (since v15). No id, rev, z or author. */
export const shapeItemSchema = z.strictObject({
  ref: itemRefSchema,
  rank: itemRank.optional(),
  kind: shapeKindSchema,
  x: boardX,
  y: boardY,
  w: shapeW,
  h: shapeH,
  text: shapeTextIn,
  ...shapeStyleShape,
});
export type ShapeItem = z.infer<typeof shapeItemSchema>;

export const ITEM_KINDS = ["note", "frame", "shape"] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];
/** Why one item was refused: it didn't validate (or clean), or the room has its notes, frames or shapes already. */
export const ITEM_REFUSALS = ["invalid", "notes_full", "frames_full", "shapes_full"] as const;
export type ItemRefusalReason = (typeof ITEM_REFUSALS)[number];

const itemCount = (m: { notes?: readonly unknown[] | undefined; frames?: readonly unknown[] | undefined; shapes?: readonly unknown[] | undefined }) =>
  (m.notes?.length ?? 0) + (m.frames?.length ?? 0) + (m.shapes?.length ?? 0);

/**
 * Notes, frames and (since v15) shapes with their content, in one message (duplicate, undo and templates). The
 * envelope is strict; entries are checked one by one (checkItems), so the good ones are added and
 * the bad ones named back. 1 to MAX_BATCH_ENTRIES items in total, and the whole message must fit
 * MAX_MESSAGE_BYTES (the web packs by size). Notes' array order is their stacking order (last on
 * top). Send entries typed as NoteItem and FrameItem.
 */
export const itemsAddSchema = z
  .strictObject({
    type: z.literal("itemsAdd"),
    clientRef: clientRefSchema,
    notes: z.array(z.unknown()).max(MAX_BATCH_ENTRIES).optional(),
    frames: z.array(z.unknown()).max(MAX_BATCH_ENTRIES).optional(),
    shapes: z.array(z.unknown()).max(MAX_BATCH_ENTRIES).optional(),
  })
  .refine((m) => itemCount(m) >= 1 && itemCount(m) <= MAX_BATCH_ENTRIES, { message: "1 to 50 items." });

/** One refused item: which list (`kind`), its index there, its ref when readable, and why. */
export const itemRefusalSchema = z.strictObject({
  kind: z.enum(ITEM_KINDS),
  index: z.number().int().min(0).max(MAX_BATCH_ENTRIES - 1),
  ref: itemRefSchema.optional(),
  reason: z.enum(ITEM_REFUSALS),
});
export type ItemRefusal = z.infer<typeof itemRefusalSchema>;

export interface ItemsCheck {
  notes: { index: number; entry: NoteItem }[];
  frames: { index: number; entry: FrameItem }[];
  shapes: { index: number; entry: ShapeItem }[];
  /** Entries that didn't validate, in order (notes, then frames, then shapes). */
  invalid: ItemRefusal[];
  /** Some ref appears twice (across all lists): the whole message is refused. */
  duplicate: boolean;
}

const readableRef = (entry: unknown): string | undefined => {
  if (typeof entry !== "object" || entry === null || !("ref" in entry)) return undefined;
  const parsed = itemRefSchema.safeParse(entry.ref);
  return parsed.success ? parsed.data : undefined;
};

/** Checks each entry of an itemsAdd. A message that uses any ref twice is refused whole. */
export function checkItems(notes: readonly unknown[] = [], frames: readonly unknown[] = [], shapes: readonly unknown[] = []): ItemsCheck {
  const refs = [...notes, ...frames, ...shapes].map(readableRef).filter((r): r is string => r !== undefined);
  const result: ItemsCheck = { notes: [], frames: [], shapes: [], invalid: [], duplicate: new Set(refs).size !== refs.length };
  if (result.duplicate) return result;
  const check = <T>(kind: ItemKind, entries: readonly unknown[], schema: z.ZodType<T>, valid: { index: number; entry: T }[]) =>
    entries.forEach((entry, index) => {
      const parsed = schema.safeParse(entry);
      if (parsed.success) return valid.push({ index, entry: parsed.data });
      const ref = readableRef(entry);
      result.invalid.push({ kind, index, ...(ref !== undefined ? { ref } : {}), reason: "invalid" });
    });
  check("note", notes, noteItemSchema, result.notes);
  check("frame", frames, frameItemSchema, result.frames);
  check("shape", shapes, shapeItemSchema, result.shapes);
  return result;
}

/* ── Host, lock, timer, End session (protocol v12) ──────────────────────────────────── */

/** A host token: base64url of a full HMAC-SHA256 (32 bytes, 43 characters). */
export const HOST_TOKEN_LENGTH = 43;
export const hostTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/** Claim host powers with the token from room creation. Sent after `joined`. */
export const claimHostSchema = z.strictObject({
  type: z.literal("claimHost"),
  token: hostTokenSchema,
});

/** Host only: lock or unlock the board for everyone else. */
export const lockSetSchema = z.strictObject({
  type: z.literal("lockSet"),
  locked: z.boolean(),
});

/** Host only: start (or replace) the room's timer. */
export const timerStartSchema = z.strictObject({
  type: z.literal("timerStart"),
  durationMs: z.number().int().min(TIMER_MIN_MS).max(TIMER_MAX_MS),
});

/** Host only: stop the timer. */
export const timerStopSchema = z.strictObject({ type: z.literal("timerStop") });

/** Host only: end the session for everyone and delete it. */
export const endSessionSchema = z.strictObject({ type: z.literal("endSession") });

/* ── Dot voting (protocol v13) ──────────────────────────────────────────── */

export const voterKeySchema = z.string().regex(new RegExp(`^[A-Za-z0-9_-]{${VOTER_KEY_MIN_LENGTH},${VOTER_KEY_MAX_LENGTH}}$`));
const voteBudget = z.number().int().min(VOTE_BUDGET_MIN).max(VOTE_BUDGET_MAX);
/** Dots on one note from one voter (the budget is checked by the relay). */
const voteCount = z.number().int().min(0).max(VOTE_BUDGET_MAX);

/** Become a voter with this device's key for the room. Sent after `joined` (every join and reconnect). */
export const claimVoterSchema = z.strictObject({
  type: z.literal("claimVoter"),
  key: voterKeySchema,
});

/** Put `count` of my dots on a note (0 takes them all off). Only while open, after claimVoter. */
export const voteSetSchema = z.strictObject({
  type: z.literal("voteSet"),
  noteId: noteIdSchema,
  count: voteCount,
});

/** Host only: start a new round (every earlier vote is deleted). */
export const voteStartSchema = z.strictObject({
  type: z.literal("voteStart"),
  budget: voteBudget,
});

/** Host only: close the round and reveal the totals to everyone. */
export const voteStopSchema = z.strictObject({ type: z.literal("voteStop") });

/** Host only: delete every vote and turn voting off. */
export const voteClearSchema = z.strictObject({ type: z.literal("voteClear") });

/* ── Live cursors (protocol v14) ────────────────────────────────────────── */

/**
 * How far outside the board a pointer position may be (board units): a pointer just past an edge
 * is still sent rather than refused. The relay clamps to the board (clampCursor).
 */
export const CURSOR_TOLERANCE = 64;
const cursorX = z.number().min(-CURSOR_TOLERANCE).max(BOARD_WIDTH + CURSOR_TOLERANCE);
const cursorY = z.number().min(-CURSOR_TOLERANCE).max(BOARD_HEIGHT + CURSOR_TOLERANCE);

/**
 * My pointer is here (board units, finite; zod refuses NaN and Infinity). Strict: no id, name or
 * colour, so nothing a page sends can speak for another participant.
 */
export const cursorSchema = z.strictObject({
  type: z.literal("cursor"),
  x: cursorX,
  y: cursorY,
});

/** My pointer left the board (or the page lost focus). */
export const cursorLeftSchema = z.strictObject({ type: z.literal("cursorLeft") });

/** Rounds a pointer position to whole units and clamps it to the board (edges included). */
export function clampCursor(x: number, y: number): { x: number; y: number } {
  return { x: between(whole(x, 0), 0, BOARD_WIDTH), y: between(whole(y, 0), 0, BOARD_HEIGHT) };
}

export const clientMessageSchema = z.discriminatedUnion("type", [
  helloSchema,
  joinSchema,
  saySchema,
  noteAddSchema,
  noteEditSchema,
  noteMoveSchema,
  noteResizeSchema,
  noteDeleteSchema,
  noteBatchSchema,
  notesOrderSchema,
  frameAddSchema,
  frameEditSchema,
  frameMoveSchema,
  frameResizeSchema,
  frameDeleteSchema,
  shapeAddSchema,
  shapeEditSchema,
  shapeMoveSchema,
  shapeResizeSchema,
  shapeDeleteSchema,
  shapeBatchSchema,
  itemsAddSchema,
  claimHostSchema,
  lockSetSchema,
  timerStartSchema,
  timerStopSchema,
  endSessionSchema,
  claimVoterSchema,
  voteSetSchema,
  voteStartSchema,
  voteStopSchema,
  voteClearSchema,
  cursorSchema,
  cursorLeftSchema,
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;
export type ClientMessageType = ClientMessage["type"];

/**
 * Every client message type, and whether it changes the board (protocol v12). While the board is
 * locked, a non-host's board-changing messages are refused with board_locked. A Record, so a new
 * message type can't be added without deciding (the compiler and a test check every type).
 */
export const BOARD_WRITES: Readonly<Record<ClientMessageType, boolean>> = {
  hello: false,
  join: false,
  say: false,
  noteAdd: true,
  noteEdit: true,
  noteMove: true,
  noteResize: true,
  noteDelete: true,
  noteBatch: true,
  notesOrder: true,
  frameAdd: true,
  frameEdit: true,
  frameMove: true,
  frameResize: true,
  frameDelete: true,
  shapeAdd: true,
  shapeEdit: true,
  shapeMove: true,
  shapeResize: true,
  shapeDelete: true,
  shapeBatch: true,
  itemsAdd: true,
  claimHost: false,
  lockSet: false,
  timerStart: false,
  timerStop: false,
  endSession: false,
  // Dot voting (v13) never changes the board: a locked board still takes votes.
  claimVoter: false,
  voteSet: false,
  voteStart: false,
  voteStop: false,
  voteClear: false,
  // Live cursors (v14) are pointers, not edits: a locked board still shows everyone's.
  cursor: false,
  cursorLeft: false,
};

/** Host-only messages: anyone else gets not_host. */
export const HOST_ONLY: readonly ClientMessageType[] = ["lockSet", "timerStart", "timerStop", "endSession", "voteStart", "voteStop", "voteClear"];

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
  "frames_full",
  "shapes_full",
  "bad_host_token",
  "not_host",
  "board_locked",
  "voters_full",
  "over_budget",
  "voting_closed",
  "no_voter",
]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

/** Server-assigned participant id: 12 random bytes, base64url. */
export const participantIdSchema = serverIdSchema;

/** What the server sends about a person. Names are already clean; anything else is rejected. */
export const participantSchema = z.object({
  id: participantIdSchema,
  name: z.string().refine((name) => cleanName(name) === name),
  colourIndex: z.number().int().min(0).max(MAX_PARTICIPANTS - 1),
  /** Claimed host powers with the room's host token (protocol v12). Set by the server only. */
  host: z.boolean(),
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
  /** A refused batch's entries, by index. */
  entries: z.array(z.number().int().min(0).max(MAX_BATCH_ENTRIES - 1)).max(MAX_BATCH_ENTRIES).optional(),
  /** The notes those entries were about (a refused batch's notes), so the sender rolls back only those. */
  noteIds: z.array(noteIdSchema).max(MAX_BATCH_ENTRIES).optional(),
  /** The frame a refused frame edit, move, resize or delete was about. */
  frameId: frameIdSchema.optional(),
  /** The shape a refused shape edit, move, resize or delete was about (v15). */
  shapeId: shapeIdSchema.optional(),
  /** A refused shapeBatch's shapes, or the shapes a refused frameMove was carrying (v15). */
  shapeIds: z.array(shapeIdSchema).max(MAX_BATCH_ENTRIES).optional(),
  /** An itemsAdd where nothing was added (its `clientRef` names it): each refused item and why. */
  refused: z.array(itemRefusalSchema).max(MAX_BATCH_ENTRIES).optional(),
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
  /** Stacking order, server-assigned: higher is in front (ties by id; see stack.ts). */
  z: z.number().int().min(-NOTE_Z_LIMIT).max(NOTE_Z_LIMIT),
  /** Server-assigned; starts at 1 and goes up by one on every stored change. */
  rev: z.number().int().min(1),
  /** The participant who added it, from their socket. Participant ids are per visit. */
  authorId: participantIdSchema,
}).refine(onBoard);
export type Note = z.infer<typeof noteSchema>;
/** The style fields of a note (what noteEdit can change besides text). */
export type NoteStyle = Pick<Note, NoteStyleField>;

/**
 * The room's timer as the server sends it: `startedAt` by the server's clock, and `serverNow`
 * (the server's clock when it sent this) so a page can work out its own clock's offset.
 */
export const timerSchema = z.strictObject({
  startedAt: z.number().int().nonnegative(),
  durationMs: z.number().int().min(TIMER_MIN_MS).max(TIMER_MAX_MS),
  serverNow: z.number().int().nonnegative(),
});
export type TimerState = z.infer<typeof timerSchema>;

/** The room's voting state (protocol v13). `round` counts rounds started (0: none yet). */
export const votingSchema = z.strictObject({
  state: z.enum(VOTING_STATES),
  budget: voteBudget,
  round: z.number().int().nonnegative(),
});
export type VotingState = z.infer<typeof votingSchema>;

/**
 * Sent first after a join. Since v12 it also carries the lock and the timer, so a page knows them
 * before the snapshots (same handler step: nothing can land in between).
 */
export const joinedSchema = z.object({
  type: z.literal("joined"),
  you: participantSchema,
  participants: z.array(participantSchema).max(MAX_PARTICIPANTS),
  locked: z.boolean(),
  timer: timerSchema.nullable(),
  /** Since v13: the voting state (if closed, votesRevealed follows the snapshots). */
  voting: votingSchema,
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

/** Every note on the board, in creation order (stacking is by z). Sent right after `joined`. */
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

/** One note's result in a batch: exactly what noteMoved, noteResized or noteDeleted would say. */
export const noteBatchResultSchema = z.discriminatedUnion("type", [noteMovedSchema, noteResizedSchema, noteDeletedSchema]);
export type NoteBatchResult = z.infer<typeof noteBatchResultSchema>;

/** A batch applied: final ones go to everyone (stored, one rev bump per changed note); live ones to the others. */
export const notesBatchAppliedSchema = z.object({
  type: z.literal("notesBatchApplied"),
  results: z.array(noteBatchResultSchema).min(1).max(MAX_BATCH_ENTRIES),
  final: z.boolean(),
});

/** One note's place in the stack after a notesOrder (or a renumbering), at its rev. */
export const noteOrderResultSchema = z.object({
  id: noteIdSchema,
  z: noteSchema.shape.z,
  rev: noteSchema.shape.rev,
});

/**
 * Notes (and since v15 shapes) restacked: every item a notesOrder named (changed or not, so the
 * sender's view matches), plus any others a renumbering at the bound moved. Sent to everyone. Up
 * to every note and shape in a room; an id is a note's or a shape's (ids never collide).
 */
export const notesOrderedSchema = z.object({
  type: z.literal("notesOrdered"),
  results: z.array(noteOrderResultSchema).min(1).max(MAX_NOTES_PER_ROOM + MAX_SHAPES_PER_ROOM),
});

/** A frame as the server stores and sends it. The title is already clean; anything else is rejected. */
export const frameSchema = z
  .object({
    id: frameIdSchema,
    x: z.number().int().min(0).max(BOARD_WIDTH - FRAME_MIN_W),
    y: z.number().int().min(0).max(BOARD_HEIGHT - FRAME_MIN_H),
    w: frameW,
    h: frameH,
    title: z.string().refine((title) => cleanFrameTitle(title) === title),
    color: frameColorSchema,
    titleFontSize: noteFontSizeSchema,
    titleBold: z.boolean(),
    titleItalic: z.boolean(),
    titleTextColor: noteTextColorSchema,
    titleAlign: noteAlignSchema,
    /** Server-assigned; starts at 1 and goes up by one on every stored change. */
    rev: z.number().int().min(1),
    /** The participant who added it, from their socket. */
    authorId: participantIdSchema,
  })
  .refine(onBoard);
export type Frame = z.infer<typeof frameSchema>;

/** Every frame on the board, in creation order. Sent right after `snapshot`, in the same step, so nothing lands between them. */
export const framesSnapshotSchema = z.strictObject({
  type: z.literal("framesSnapshot"),
  frames: z.array(frameSchema).max(MAX_FRAMES_PER_ROOM),
});

export const frameAddedSchema = z.object({
  type: z.literal("frameAdded"),
  frame: frameSchema,
  /** Only in the copy sent to the frame's sender. */
  clientRef: clientRefSchema.optional(),
});

/** Title, colour or title style changed. Carries the whole frame. */
export const frameUpdatedSchema = z.object({
  type: z.literal("frameUpdated"),
  frame: frameSchema,
});

/** A carried note's new place (at its rev: bumped on a final move that changed it). */
export const carriedNoteSchema = z.object({
  id: noteIdSchema,
  x: noteSchema.shape.x,
  y: noteSchema.shape.y,
  rev: noteSchema.shape.rev,
});

/** A carried shape's new place (v15), like carriedNoteSchema at shape bounds. */
export const carriedShapeSchema = z.object({
  id: shapeIdSchema,
  x: z.number().int().min(0).max(BOARD_WIDTH - SHAPE_MIN_W),
  y: z.number().int().min(0).max(BOARD_HEIGHT - SHAPE_MIN_H),
  rev: z.number().int().min(1),
});

/**
 * A frame moved, with the notes it carried (one message, so pages apply both at once). Live
 * moves go to everyone but the mover at the current revs; final ones go to everyone.
 */
export const frameMovedSchema = z.object({
  type: z.literal("frameMoved"),
  id: frameIdSchema,
  x: frameSchema.shape.x,
  y: frameSchema.shape.y,
  rev: z.number().int().min(1),
  final: z.boolean(),
  notes: z.array(carriedNoteSchema).max(MAX_BATCH_ENTRIES).optional(),
  /** Since v15: the shapes it carried, like notes. */
  shapes: z.array(carriedShapeSchema).max(MAX_BATCH_ENTRIES).optional(),
});

export const frameResizedSchema = z
  .object({
    type: z.literal("frameResized"),
    id: frameIdSchema,
    x: frameSchema.shape.x,
    y: frameSchema.shape.y,
    w: frameW,
    h: frameH,
    rev: z.number().int().min(1),
    final: z.boolean(),
  })
  .refine(onBoard);

export const frameDeletedSchema = z.object({
  type: z.literal("frameDeleted"),
  id: frameIdSchema,
});

/** A shape as the server stores and sends it (v15). Text is already clean; anything else is rejected. */
export const shapeSchema = z
  .object({
    id: shapeIdSchema,
    kind: shapeKindSchema,
    x: z.number().int().min(0).max(BOARD_WIDTH - SHAPE_MIN_W),
    y: z.number().int().min(0).max(BOARD_HEIGHT - SHAPE_MIN_H),
    w: shapeW,
    h: shapeH,
    text: z.string().refine((text) => cleanShapeText(text) === text),
    ...shapeStyleShape,
    /** Stacking order, in the notes' space (server-assigned). */
    z: z.number().int().min(-NOTE_Z_LIMIT).max(NOTE_Z_LIMIT),
    /** Server-assigned; starts at 1 and goes up by one on every stored change. */
    rev: z.number().int().min(1),
    /** The participant who added it, from their socket. */
    authorId: participantIdSchema,
  })
  .refine(onBoard);
export type Shape = z.infer<typeof shapeSchema>;

/** Every shape on the board, in creation order. Sent right after `framesSnapshot`, in the same step. */
export const shapesSnapshotSchema = z.strictObject({
  type: z.literal("shapesSnapshot"),
  shapes: z.array(shapeSchema).max(MAX_SHAPES_PER_ROOM),
});

export const shapeAddedSchema = z.object({
  type: z.literal("shapeAdded"),
  shape: shapeSchema,
  /** Only in the copy sent to the shape's sender. */
  clientRef: clientRefSchema.optional(),
});

/** Text or style changed. Carries the whole shape. */
export const shapeUpdatedSchema = z.object({
  type: z.literal("shapeUpdated"),
  shape: shapeSchema,
});

/** Non-final moves go to everyone but the mover at the current rev; final ones bump it. */
export const shapeMovedSchema = z.object({
  type: z.literal("shapeMoved"),
  id: shapeIdSchema,
  x: shapeSchema.shape.x,
  y: shapeSchema.shape.y,
  rev: z.number().int().min(1),
  final: z.boolean(),
});

export const shapeResizedSchema = z
  .object({
    type: z.literal("shapeResized"),
    id: shapeIdSchema,
    x: shapeSchema.shape.x,
    y: shapeSchema.shape.y,
    w: shapeW,
    h: shapeH,
    rev: z.number().int().min(1),
    final: z.boolean(),
  })
  .refine(onBoard);

export const shapeDeletedSchema = z.object({
  type: z.literal("shapeDeleted"),
  id: shapeIdSchema,
});

/** One shape's result in a shapeBatch: exactly what shapeMoved, shapeResized or shapeDeleted would say. */
export const shapeBatchResultSchema = z.discriminatedUnion("type", [shapeMovedSchema, shapeResizedSchema, shapeDeletedSchema]);
export type ShapeBatchResult = z.infer<typeof shapeBatchResultSchema>;

/** A shapeBatch applied: final ones to everyone, live ones to the others. */
export const shapesBatchAppliedSchema = z.object({
  type: z.literal("shapesBatchApplied"),
  results: z.array(shapeBatchResultSchema).min(1).max(MAX_BATCH_ENTRIES),
  final: z.boolean(),
});

/**
 * Items added by one itemsAdd, in one message (one view update). Notes in their stacking order
 * (bottom first); any renumbering at the bound was sent before it as notesOrdered. To everyone;
 * `clientRef`, each `ref` and `refused` (items that weren't added) only mean something to the
 * sender, so the others' copies have no refs and an empty `refused`. Never sent with nothing added.
 */
export const itemsAddedSchema = z
  .object({
    type: z.literal("itemsAdded"),
    clientRef: clientRefSchema.optional(),
    notes: z.array(z.object({ ref: itemRefSchema.optional(), note: noteSchema })).max(MAX_BATCH_ENTRIES),
    frames: z.array(z.object({ ref: itemRefSchema.optional(), frame: frameSchema })).max(MAX_BATCH_ENTRIES),
    /** Since v15; left out when no shape was added. */
    shapes: z.array(z.object({ ref: itemRefSchema.optional(), shape: shapeSchema })).max(MAX_BATCH_ENTRIES).optional(),
    refused: z.array(itemRefusalSchema).max(MAX_BATCH_ENTRIES),
  })
  .refine((m) => itemCount(m) >= 1 && itemCount(m) + m.refused.length <= MAX_BATCH_ENTRIES);

/** The claim worked: this socket now has host powers (others get participantUpdated). */
export const hostGrantedSchema = z.strictObject({ type: z.literal("hostGranted") });

/** A participant changed (today: became host). Carries the whole participant. */
export const participantUpdatedSchema = z.strictObject({
  type: z.literal("participantUpdated"),
  participant: participantSchema,
});

export const lockChangedSchema = z.strictObject({
  type: z.literal("lockChanged"),
  locked: z.boolean(),
});

export const timerChangedSchema = z.strictObject({
  type: z.literal("timerChanged"),
  timer: timerSchema.nullable(),
});

/** A host ended the session. Every socket is then closed with ROOM_ENDED_CLOSE_CODE. */
export const sessionEndedSchema = z.strictObject({ type: z.literal("sessionEnded") });

/** One note's dots: a voter's own (voterGranted), or everyone's (votesRevealed). Never says who. */
export const noteVotesSchema = z.strictObject({
  noteId: noteIdSchema,
  count: z.number().int().min(1).max(MAX_VOTERS_PER_ROUND * VOTE_BUDGET_MAX),
});
const remainingSchema = z.number().int().min(0).max(VOTE_BUDGET_MAX);

/** The claim worked: this socket votes as that voter. Its own votes this round, and dots left. */
export const voterGrantedSchema = z.strictObject({
  type: z.literal("voterGranted"),
  remaining: remainingSchema,
  mine: z.array(noteVotesSchema.extend({ count: voteCount.min(1) })).max(VOTE_BUDGET_MAX),
});

/** Voting started, stopped or cleared. To everyone. */
export const votingChangedSchema = z.strictObject({
  type: z.literal("votingChanged"),
  voting: votingSchema,
});

/** A voteSet stored (or already so). Only to the voter's own sockets. */
export const voteConfirmedSchema = z.strictObject({
  type: z.literal("voteConfirmed"),
  noteId: noteIdSchema,
  count: voteCount,
  remaining: remainingSchema,
});

/**
 * The round's totals, non-zero only, in note creation order: to everyone when a host stops
 * voting, and to a joiner while closed. Totals only: never who voted for what.
 */
export const votesRevealedSchema = z.strictObject({
  type: z.literal("votesRevealed"),
  round: z.number().int().nonnegative(),
  totals: z.array(noteVotesSchema).max(MAX_NOTES_PER_ROOM),
});

/**
 * Someone else's pointer (protocol v14), at whole board units. To everyone but its owner; the id is
 * the owner's participant id from their socket. Name and colour come from the participant list.
 */
export const cursorMovedSchema = z.strictObject({
  type: z.literal("cursorMoved"),
  id: participantIdSchema,
  x: z.number().int().min(0).max(BOARD_WIDTH),
  y: z.number().int().min(0).max(BOARD_HEIGHT),
});

/** Someone's pointer left the board, or they left. */
export const cursorGoneSchema = z.strictObject({
  type: z.literal("cursorGone"),
  id: participantIdSchema,
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
  notesBatchAppliedSchema,
  notesOrderedSchema,
  framesSnapshotSchema,
  frameAddedSchema,
  frameUpdatedSchema,
  frameMovedSchema,
  frameResizedSchema,
  frameDeletedSchema,
  itemsAddedSchema,
  shapesSnapshotSchema,
  shapeAddedSchema,
  shapeUpdatedSchema,
  shapeMovedSchema,
  shapeResizedSchema,
  shapeDeletedSchema,
  shapesBatchAppliedSchema,
  hostGrantedSchema,
  participantUpdatedSchema,
  lockChangedSchema,
  timerChangedSchema,
  sessionEndedSchema,
  voterGrantedSchema,
  votingChangedSchema,
  voteConfirmedSchema,
  votesRevealedSchema,
  cursorMovedSchema,
  cursorGoneSchema,
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;
