import { isBound, type ConnectorEnd, type ShapeKind } from "@stickyard/shared";
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
  /** Arrows (v0.36.0), in creation order: only their ends, never their style. */
  connectors?: readonly { start: ConnectorEnd; end: ConnectorEnd }[];
  /** Groups (v0.38.0), in creation order: only their label and members, never their colour. */
  groups?: readonly { label: string; members: readonly string[] }[];
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
  connections: "Connections",
  freeEnd: "(free end)",
  emptyShape: "Empty shape",
  group: "Group",
  untitledGroup: "Untitled group",
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

/** A shape's line: its kind and text, or that it's empty. */
const shapeLine = (s: { kind: ShapeKind; text: string }) => {
  const text = plain(s.text);
  return `- ${SHAPE_KIND_NAMES[s.kind]}: ${text === "" ? `*${EXPORT_TEXT.emptyShape}*` : text}`;
};

/** The whole file: title and date, a section per frame, the unframed notes, labels and shapes, then results. */
export function boardToMarkdown(board: ExportBoard, date: Date): string {
  const totals = board.results ? new Map(board.results.map((r) => [r.noteId, r.count])) : null;
  const dotsOf = (id: string) => (totals ? (totals.get(id) ?? 0) : null);
  const out: string[] = [`# ${EXPORT_TEXT.title}`, "", `Exported ${localDate(date)}`];
  const section = (heading: string, lines: string[]) => out.push("", `## ${heading}`, "", ...lines);

  // Groups (v0.38.0): each is listed once, as a sub-list under its label, in the section its box's
  // centre falls in (the frames' centre rule, applied to the box round its members). Its notes and
  // shapes are listed there and nowhere else.
  const noteById = new Map(board.notes.map((n) => [n.id, n] as const));
  const shapeById = new Map(board.shapes.map((x) => [x.id, x] as const));
  const grouped = new Set<string>();
  const groups = (board.groups ?? []).flatMap((g, i) => {
    // A shape keeps its kind (`shapeKind`); a note has none.
    type Item = { id: string; x: number; y: number; w: number; h: number; text: string; shapeKind: ShapeKind | null };
    const items = g.members.flatMap((id): Item[] => {
      const n = noteById.get(id);
      if (n) return [{ ...n, shapeKind: null }];
      const x = shapeById.get(id);
      return x ? [{ ...x, shapeKind: x.kind }] : [];
    });
    if (items.length === 0) return [];
    for (const item of items) grouped.add(item.id);
    const left = Math.min(...items.map((r) => r.x));
    const top = Math.min(...items.map((r) => r.y));
    const right = Math.max(...items.map((r) => r.x + r.w));
    const bottom = Math.max(...items.map((r) => r.y + r.h));
    return [{ id: `group:${i}`, x: left, y: top, w: right - left, h: bottom - top, label: g.label, items }];
  });
  const groupLines = (g: (typeof groups)[number]) => {
    const label = plain(g.label);
    return [
      `- ${EXPORT_TEXT.group}: ${label === "" ? `*${EXPORT_TEXT.untitledGroup}*` : label}`,
      ...readingOrder(g.items).map((item) => `  ${item.shapeKind !== null ? shapeLine({ kind: item.shapeKind, text: item.text }) : noteLine(item.text, dotsOf(item.id))}`),
    ];
  };
  const loneNotes = board.notes.filter((n) => !grouped.has(n.id));

  // Each note goes to the first frame (in reading order) its centre is inside: the frame carry's rule.
  const placed = new Set<string>();
  for (const frame of readingOrder(board.frames)) {
    const inside = readingOrder(framedNotes(frame, loneNotes).filter((n) => !placed.has(n.id)));
    for (const n of inside) placed.add(n.id);
    const boxes = readingOrder(framedNotes(frame, groups).filter((g) => !placed.has(g.id)));
    for (const g of boxes) placed.add(g.id);
    const title = plain(frame.title);
    const lines = [...inside.map((n) => noteLine(n.text, dotsOf(n.id))), ...boxes.flatMap(groupLines)];
    section(title === "" ? EXPORT_TEXT.untitledFrame : title, lines.length ? lines : [`*${EXPORT_TEXT.noNotes}*`]);
  }
  const loose = readingOrder(loneNotes.filter((n) => !placed.has(n.id)));
  const looseGroups = readingOrder(groups.filter((g) => !placed.has(g.id)));
  if (loose.length + looseGroups.length) section(EXPORT_TEXT.unframed, [...loose.map((n) => noteLine(n.text, dotsOf(n.id))), ...looseGroups.flatMap(groupLines)]);

  const shapes = readingOrder(board.shapes.filter((x) => !grouped.has(x.id))).flatMap((s) => {
    const text = plain(s.text);
    return text === "" ? [] : [`- ${SHAPE_KIND_NAMES[s.kind]}: ${text}`];
  });
  if (shapes.length) section(EXPORT_TEXT.shapes, shapes);

  // Arrows: "A → B" from each end's item text (one line, escaped), or "(free end)". An arrow whose
  // item isn't on the board is left out.
  const textOf = new Map<string, string>([
    ...board.notes.map((n) => {
      const t = plain(n.text);
      return [n.id, t === "" ? `*${EXPORT_TEXT.emptyNote}*` : t] as const;
    }),
    ...board.shapes.map((s) => {
      const t = plain(s.text);
      return [s.id, t === "" ? `*${EXPORT_TEXT.emptyShape}*` : t] as const;
    }),
  ]);
  const endText = (end: ConnectorEnd) => (isBound(end) ? textOf.get(end.item) : EXPORT_TEXT.freeEnd);
  const connections = (board.connectors ?? []).flatMap((c) => {
    const a = endText(c.start);
    const b = endText(c.end);
    return a === undefined || b === undefined ? [] : [`- ${a} → ${b}`];
  });
  if (connections.length) section(EXPORT_TEXT.connections, connections);

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
