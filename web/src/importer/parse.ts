import {
  BOARD_HEIGHT,
  BOARD_WIDTH,
  MAX_CONNECTORS_PER_ROOM,
  MAX_FRAMES_PER_ROOM,
  MAX_GROUPS_PER_ROOM,
  MAX_NOTE_TEXT,
  MAX_NOTES_PER_ROOM,
  MAX_SHAPES_PER_ROOM,
  NOTE_DEFAULTS,
  clampFrameRect,
  clampNoteRect,
  clampShapeRect,
  cleanNoteText,
  truncateCodePoints,
  utf8Length,
} from "@stickyard/shared";
import { BOARD_FILE_FORMAT, BOARD_FILE_VERSION } from "../export/boardFile";
import { parseStencil, type Stencil } from "../stencils/data";

/*
 * Import (v0.40.0, part 2 of Export on phones and Import, web only): reading a board file or plain
 * text into what the board places. Everything here is untrusted data, never instructions: the size
 * is capped before anything is parsed, JSON.parse is the only reader (nothing is evaluated, fetched
 * or followed), every item goes through the stencil parser (exact keys, the protocol's style keys,
 * rects clamped, text cut to its cap and cleaned exactly as typed text is), and ids, revs, z,
 * authors, votes, reactions and ranks are dropped wherever they appear. Pure: no React, no DOM.
 */

/** A file or text to import, at most (UTF-8 bytes). The largest board’s file is about 470 KB (tested), so 1 MB leaves room. */
export const IMPORT_MAX_BYTES = 1024 * 1024;

export type ImportKind = "notes" | "shapes" | "frames" | "arrows" | "groups";
export type ImportCounts = Record<ImportKind, number>;

/** What gets placed: the stencil format (refs, places from 0, 0), the stacking order and how many lines were cut. */
export interface ImportContent extends Stencil {
  /** Every note's and shape's ref once, bottom first. */
  stack: string[];
  /** Text lines longer than a note holds (cut to fit). */
  cut: number;
}

export type ImportResult = { ok: true; content: ImportContent } | { ok: false; reason: string };

const CAPS: ImportCounts = {
  notes: MAX_NOTES_PER_ROOM,
  shapes: MAX_SHAPES_PER_ROOM,
  frames: MAX_FRAMES_PER_ROOM,
  arrows: MAX_CONNECTORS_PER_ROOM,
  groups: MAX_GROUPS_PER_ROOM,
};
const ONE: Record<ImportKind, string> = { notes: "note", shapes: "shape", frames: "frame", arrows: "arrow", groups: "group" };
const count = (n: number, kind: ImportKind) => `${n} ${n === 1 ? ONE[kind] : kind}`;
/** The order counts are listed and room is checked in (frames first, as stencils). */
const KINDS: readonly ImportKind[] = ["frames", "notes", "shapes", "arrows", "groups"];

/** "2 notes, 1 frame and 1 group" (kinds with none left out). */
export function countsText(c: ImportCounts): string {
  const parts = (["notes", "shapes", "frames", "arrows", "groups"] as const).filter((k) => c[k] > 0).map((k) => count(c[k], k));
  return parts.length <= 1 ? (parts[0] ?? "nothing") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

export const IMPORT_TEXT = {
  tooLarge: "That’s more than 1 MB, so it can’t be imported. Nothing was added.",
  readFailed: "That file couldn’t be read. Nothing was added.",
  notPlaced: "Nothing was added. Close Import to see why on the board.",
  notBoardFile: "That isn’t a Stickyard board file. Nothing was added.",
  newer: "That board file comes from a newer version of Stickyard. Reload this page to update it, then try again. Nothing was added.",
  malformed: "That board file couldn’t be read: part of it isn’t valid. Nothing was added.",
  tooMany: (kind: ImportKind, n: number) => `That has ${count(n, kind)}, but a board holds at most ${CAPS[kind]}. Nothing was added.`,
  biggerThanBoard: `That board file’s content is bigger than the board (${BOARD_WIDTH} × ${BOARD_HEIGHT}), so it can’t be placed. Nothing was added.`,
  empty: "There’s nothing to import in that board file.",
  emptyText: "There’s no text to import. Type or paste one note per line.",
  noRoom: (fails: readonly (readonly [ImportKind, number, number])[]) =>
    `This import needs ${fails.map(([kind, needs, free]) => `${count(needs, kind)}, but the board has room for ${free} more (at most ${CAPS[kind]})`).join("; ")}. Nothing was added.`,
  cut: (n: number) => `${n} ${n === 1 ? "line was" : "lines were"} longer than ${MAX_NOTE_TEXT} characters and ${n === 1 ? "was" : "were"} cut to fit.`,
  preview: (c: ImportCounts) => `Ready to add ${countsText(c)} in the middle of your view.`,
  placed: (c: ImportCounts) => `Imported ${countsText(c)}. Undo removes all of it.`,
} as const;

export function importCounts(c: Stencil): ImportCounts {
  return { notes: c.notes.length, shapes: c.shapes.length, frames: c.frames.length, arrows: c.arrows.length, groups: c.groups.length };
}

/** Everything that wouldn't fit beside what's on the board (`used`): [kind, needs, free], frames first. */
export function importRoomFails(c: Stencil, used: ImportCounts): [ImportKind, number, number][] {
  const needs = importCounts(c);
  return KINDS.flatMap((k): [ImportKind, number, number][] => {
    const free = Math.max(0, CAPS[k] - used[k]);
    return needs[k] > free ? [[k, needs[k], free]] : [];
  });
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const refuse = (reason: string): ImportResult => ({ ok: false, reason });

/** Keys a file may carry that are never imported: the server's ids, revs and stacking, authors, votes, reactions. */
const IGNORED = new Set(["id", "rev", "z", "rank", "authorId", "author", "votes", "dots", "reactions", "sealed", "writer"]);
const withoutIgnored = (v: unknown): unknown => (isRecord(v) ? Object.fromEntries(Object.entries(v).filter(([k]) => !IGNORED.has(k))) : v);

type Rect = { x: number; y: number; w: number; h: number };
const clamps: Record<"notes" | "shapes" | "frames", (r: Rect) => Rect> = { notes: clampNoteRect, shapes: clampShapeRect, frames: clampFrameRect };

/**
 * Moves the items so the top-left is 0, 0 and says whether they fit on the board (sizes as the
 * board would clamp them). Items with a missing or non-number place are left for the stencil
 * parser to refuse.
 */
function normalise(lists: Record<ImportKind, unknown[]>): { lists: Record<ImportKind, unknown[]>; fits: boolean } {
  const rects = (["notes", "shapes", "frames"] as const).flatMap((k) =>
    lists[k].flatMap((v) => (isRecord(v) && finite(v.x) && finite(v.y) && finite(v.w) && finite(v.h) ? [{ x: v.x, y: v.y, w: clamps[k]({ x: 0, y: 0, w: v.w, h: v.h }).w, h: clamps[k]({ x: 0, y: 0, w: v.w, h: v.h }).h }] : [])),
  );
  const freeEnd = (e: unknown): e is { x: number; y: number } => isRecord(e) && !("ref" in e) && finite(e.x) && finite(e.y);
  const points = lists.arrows.flatMap((a) => (isRecord(a) ? [a.start, a.end].filter(freeEnd) : []));
  const xs = [...rects.map((r) => r.x), ...points.map((p) => p.x)];
  const ys = [...rects.map((r) => r.y), ...points.map((p) => p.y)];
  if (xs.length === 0) return { lists, fits: true };
  const dx = Math.min(...xs);
  const dy = Math.min(...ys);
  const right = Math.max(...rects.map((r) => r.x + r.w), ...points.map((p) => p.x)) - dx;
  const bottom = Math.max(...rects.map((r) => r.y + r.h), ...points.map((p) => p.y)) - dy;
  const shift = (v: unknown) => (isRecord(v) && finite(v.x) && finite(v.y) ? { ...v, x: v.x - dx, y: v.y - dy } : v);
  const shiftArrow = (a: unknown) => (isRecord(a) ? { ...a, start: freeEnd(a.start) ? shift(a.start) : a.start, end: freeEnd(a.end) ? shift(a.end) : a.end } : a);
  return {
    lists: { ...lists, notes: lists.notes.map(shift), shapes: lists.shapes.map(shift), frames: lists.frames.map(shift), arrows: lists.arrows.map(shiftArrow) },
    fits: right <= BOARD_WIDTH && bottom <= BOARD_HEIGHT,
  };
}

/** A board file's text (Export board file's format) to place, or why not. */
export function parseBoardFile(text: string): ImportResult {
  if (utf8Length(text) > IMPORT_MAX_BYTES) return refuse(IMPORT_TEXT.tooLarge);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return refuse(IMPORT_TEXT.notBoardFile);
  }
  if (!isRecord(raw) || raw.format !== BOARD_FILE_FORMAT) return refuse(IMPORT_TEXT.notBoardFile);
  const version = raw.formatVersion;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) return refuse(IMPORT_TEXT.notBoardFile);
  if (version > BOARD_FILE_VERSION) return refuse(IMPORT_TEXT.newer);

  const lists = {} as Record<ImportKind, unknown[]>;
  for (const kind of ["notes", "shapes", "frames", "arrows", "groups"] as const) {
    const value = raw[kind] ?? [];
    if (!Array.isArray(value)) return refuse(IMPORT_TEXT.malformed);
    if (value.length > CAPS[kind]) return refuse(IMPORT_TEXT.tooMany(kind, value.length));
    lists[kind] = value.map(withoutIgnored);
  }
  if (lists.notes.length + lists.shapes.length + lists.frames.length === 0) return refuse(IMPORT_TEXT.empty);
  const { lists: placed, fits } = normalise(lists);
  if (!fits) return refuse(IMPORT_TEXT.biggerThanBoard);
  const stencil = parseStencil({ id: "import", name: "Import", ...placed });
  if (!stencil) return refuse(IMPORT_TEXT.malformed);

  const refs = [...stencil.notes, ...stencil.shapes].map((i) => i.ref);
  let stack = refs;
  if (raw.stack !== undefined) {
    const given = raw.stack;
    if (!Array.isArray(given) || given.length !== refs.length || !given.every((r): r is string => typeof r === "string") || new Set(given).size !== given.length || !given.every((r) => refs.includes(r))) {
      return refuse(IMPORT_TEXT.malformed);
    }
    stack = given;
  }
  return { ok: true, content: { ...stencil, stack, cut: 0 } };
}

/** Line breaks of every kind: one note per line. */
const LINES = /\r\n|[\n\r\u0085\u2028\u2029]/;
/** Space between notes in an imported grid, in board units. */
export const IMPORT_GAP = 24;
/** The colour imported text notes get (a new note's default). */
export const IMPORT_NOTE_COLOR = "yellow";

/** Plain text: one note per line, each cleaned exactly as typed note text (cut to the cap), blank lines dropped, in a grid from 0, 0. */
export function parseTextImport(text: string): ImportResult {
  if (utf8Length(text) > IMPORT_MAX_BYTES) return refuse(IMPORT_TEXT.tooLarge);
  let cut = 0;
  const lines = text.split(LINES).flatMap((line) => {
    let clean = cleanNoteText(line);
    if (clean === null) {
      clean = cleanNoteText(truncateCodePoints(line.trim(), MAX_NOTE_TEXT)) ?? "";
      cut++;
    }
    return clean === "" ? [] : [clean];
  });
  if (lines.length === 0) return refuse(IMPORT_TEXT.emptyText);
  if (lines.length > MAX_NOTES_PER_ROOM) return refuse(IMPORT_TEXT.tooMany("notes", lines.length));
  const columns = Math.ceil(Math.sqrt(lines.length));
  const notes = lines.map((line, i) => ({
    ref: `n${i + 1}`,
    x: (i % columns) * (NOTE_DEFAULTS.w + IMPORT_GAP),
    y: Math.floor(i / columns) * (NOTE_DEFAULTS.h + IMPORT_GAP),
    text: line,
    ...NOTE_DEFAULTS,
    color: IMPORT_NOTE_COLOR,
  }));
  const stencil = parseStencil({ id: "import", name: "Import", notes, shapes: [], frames: [], arrows: [], groups: [] });
  if (!stencil) return refuse(IMPORT_TEXT.emptyText);
  return { ok: true, content: { ...stencil, stack: stencil.notes.map((n) => n.ref), cut } };
}

/** A chosen file's text, or why it can't be read (over the cap before reading a byte). */
export async function readImportFile(file: Blob): Promise<{ ok: true; text: string } | { ok: false; reason: string }> {
  if (file.size > IMPORT_MAX_BYTES) return { ok: false, reason: IMPORT_TEXT.tooLarge };
  try {
    return { ok: true, text: await file.text() };
  } catch {
    return { ok: false, reason: IMPORT_TEXT.readFailed };
  }
}
