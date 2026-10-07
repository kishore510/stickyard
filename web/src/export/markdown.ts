import type { ShapeKind } from "@stickyard/shared";
import { readingOrder } from "../canvas/arrange";
import { framedNotes } from "../frames/board";
import { splitTitleBody } from "../notes/titleBody";
import { SHAPE_KIND_NAMES } from "../shapes/style";
import { dotsWord, type ResultRow } from "../voting/voting";

/*
 * Export Markdown (v0.22.0): the board as a Markdown file, made here from what this page shows.
 * Pure: no React, no DOM. Only what's listed in ExportBoard goes in: no room code or id, no names
 * or authors, no colours, never private dots. Room text is untrusted: cleanText + escapeInline
 * make sure no note, frame title or shape can become a heading, list, link, image, table, code or
 * HTML; instructions in it are just text.
 */

export interface ExportBoard {
  notes: readonly { id: string; x: number; y: number; w: number; h: number; text: string }[];
  frames: readonly { id: string; x: number; y: number; w: number; h: number; title: string }[];
  shapes: readonly { id: string; kind: ShapeKind; x: number; y: number; w: number; h: number; text: string }[];
  /** Revealed totals (voting closed), sorted most first; null while voting is open, off or never run. */
  results: readonly ResultRow[] | null;
}

export const EXPORT_TEXT = {
  title: "Stickyard board",
  untitledFrame: "Untitled frame",
  emptyNote: "Empty note",
  untitledNote: "Untitled note",
  noNotes: "No notes.",
  unframed: "Not in a frame",
  shapes: "Labels and shapes",
  results: "Results",
  noVotes: "No votes were cast.",
  topVoted: "Top voted",
} as const;

/** YYYY-MM-DD in local time. */
export function localDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The download's name: the date only (never a room code, id or name). */
export function exportFileName(ext: "png" | "md", date: Date): string {
  return `stickyard-board-${localDate(date)}.${ext}`;
}

// Line breaks of every kind (including NEL and the Unicode separators) become spaces.
const BREAKS = /\r\n|[\r\n\u0085\u2028\u2029\t\v\f]/g;
// C0 and C1 controls, DEL, and the bidi embeddings, overrides and isolates (they can reorder what's shown).
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** One line of plain text: lone surrogates mended, controls gone, every break a space, spaces collapsed, trimmed. */
export function cleanText(text: string): string {
  return text.replace(LONE_SURROGATE, "\uFFFD").replace(BREAKS, " ").replace(CONTROLS, "").replace(/\s+/g, " ").trim();
}

/*
 * Every ASCII character that can start Markdown or HTML is backslash-escaped (CommonMark lets any
 * ASCII punctuation be). Bare-URL autolinks (GFM: "://", "www.", e-mail "@") are broken up the
 * same way. A list or block marker can only matter at the start of a fragment, so a leading
 * "-", "+", "=" or "1." / "1)" is escaped too. Run on cleanText's output (one line).
 */
const ACTIVE = /[\\`*_[\]<>|!#~&(){}]/g;
export function escapeInline(text: string): string {
  return text
    .replace(ACTIVE, (c) => `\\${c}`)
    .replace(/:\/\//g, "\\://")
    .replace(/\b(www)\./gi, "$1\\.")
    .replace(/@/g, "\\@")
    .replace(/^([-+=])/, "\\$1")
    .replace(/^(\d+)([.)])/, "$1\\$2");
}

const plain = (text: string) => escapeInline(cleanText(text));

function noteLine(text: string, dots: number | null): string {
  const { title, body } = splitTitleBody(text);
  const t = plain(title);
  const b = plain(body);
  const main = t !== "" ? `**${t}**${b !== "" ? ` ${b}` : ""}` : b !== "" ? b : `*${EXPORT_TEXT.emptyNote}*`;
  return `- ${main}${dots === null ? "" : ` (${dotsWord(dots)})`}`;
}

/** The whole file: title and date, a section per frame, the unframed notes, labels and shapes, then results. */
export function boardToMarkdown(board: ExportBoard, date: Date): string {
  const totals = board.results ? new Map(board.results.map((r) => [r.noteId, r.count])) : null;
  const dotsOf = (id: string) => (totals ? (totals.get(id) ?? 0) : null);
  const out: string[] = [`# ${EXPORT_TEXT.title}`, "", `Exported ${localDate(date)}`];
  const section = (heading: string, lines: string[]) => out.push("", `## ${heading}`, "", ...lines);

  // Each note goes to the first frame (in reading order) its centre is inside: the frame carry's rule.
  const placed = new Set<string>();
  for (const frame of readingOrder(board.frames)) {
    const inside = readingOrder(framedNotes(frame, board.notes).filter((n) => !placed.has(n.id)));
    for (const n of inside) placed.add(n.id);
    const title = plain(frame.title);
    section(title === "" ? EXPORT_TEXT.untitledFrame : title, inside.length ? inside.map((n) => noteLine(n.text, dotsOf(n.id))) : [`*${EXPORT_TEXT.noNotes}*`]);
  }
  const loose = readingOrder(board.notes.filter((n) => !placed.has(n.id)));
  if (loose.length) section(EXPORT_TEXT.unframed, loose.map((n) => noteLine(n.text, dotsOf(n.id))));

  const shapes = readingOrder(board.shapes).flatMap((s) => {
    const text = plain(s.text);
    return text === "" ? [] : [`- ${SHAPE_KIND_NAMES[s.kind]}: ${text}`];
  });
  if (shapes.length) section(EXPORT_TEXT.shapes, shapes);

  if (board.results) {
    section(
      EXPORT_TEXT.results,
      board.results.length
        ? board.results.map((r, i) => `${i + 1}. **${plain(r.title)}**: ${dotsWord(r.count)}${r.top ? `, ${EXPORT_TEXT.topVoted}` : ""}`)
        : [EXPORT_TEXT.noVotes],
    );
  }
  return `${out.join("\n")}\n`;
}
