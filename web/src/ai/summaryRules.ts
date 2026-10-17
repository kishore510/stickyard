import { FRAME_DEFAULTS, MAX_FRAMES_PER_ROOM, MAX_NOTES_PER_ROOM, MAX_NOTE_TEXT, NOTE_COLORS, NOTE_DEFAULTS, codePointLength, truncateCodePoints, type NoteColor } from "@stickyard/shared";
import { NOTE_TOOL_REASONS } from "../canvas/tools";
import { escapeInline, cleanText } from "../export/markdown";
import { LOCK_TEXT } from "../facilitation/lock";
import type { ImportContent } from "../importer/parse";
import { UNDO_TEXT } from "../rooms/session";
import { SILENT_TEXT } from "../silent/silent";
import { parseStencil, type StencilFrame, type StencilNote } from "../stencils/data";
import type { SentimentCounts, SummaryResult } from "./summaryParse";
import { SUMMARY_LIMITS, type SentimentLabel } from "./summaryPrompt";
import { scopeNotes, summaryPayload, type SummaryScope } from "./summaryScope";

/*
 * Summary and sentiment (v0.44.0): who can use it and when, the caps, every line the feature shows,
 * what Add to board puts on the board, and Copy as Markdown. Pure.
 *
 * Host only: in a shared room it sends everyone's notes under one person's key, and the others
 * don't see it happen, so only the host may. Off during a silent round (the page sees only its own
 * hidden notes, so a summary would mislead). Nothing is announced to the room.
 */

const pad = (n: number) => String(n).padStart(2, "0");
/** HH:MM in this device's time (as Settings shows the last test). */
const clockTime = (at: number) => `${pad(new Date(at).getHours())}:${pad(new Date(at).getMinutes())}`;
const plural = (n: number, word: string) => `${n.toLocaleString("en-GB")} ${word}${n === 1 ? "" : "s"}`;
const more = (n: number, word: string) => (n === 0 ? `no more ${word}s` : `${n} more ${n === 1 ? word : `${word}s`}`);

export const SENTIMENT_NAMES: Record<SentimentLabel | "notRated", string> = {
  positive: "Positive",
  neutral: "Neutral",
  negative: "Negative",
  mixed: "Mixed",
  notRated: "Not rated",
};

export const SUMMARY_TEXT = {
  title: "Summarise board",
  hostOnly: "Only the host can send the board to AI.",
  offline: "Reconnect to summarise the board.",
  noKey: "Add your API key first",
  noKeyBody: "Summarise board uses your own Anthropic API key. Add it in Settings, under AI (your own key), then come back here.",
  intro: "The page sends the board’s text to Anthropic and shows you a summary: an overview, themes, sentiment and possible actions. Nothing is added to the board unless you choose Add to board.",
  whole: (n: number) => `Whole board (${plural(n, "note")})`,
  selection: (n: number) => `Selection (${plural(n, "note")})`,
  scopeLegend: "What to summarise",
  deeper: "Deeper analysis",
  deeperHint: (small: string, large: string) => `Uses ${large} instead of ${small}: slower and costs more.`,
  empty: "Nothing to summarise.",
  sent: (notes: number, frames: number) =>
    `The text of ${plural(notes, "note")} and ${plural(frames, "frame title")}, grouped by frame. No names, authors, ids, colours, positions or votes.`,
  everyone: "These notes were written by everyone in this session. They go to Anthropic using your key.",
  replyCap: (tokens: number) => `The reply can use up to ${tokens.toLocaleString("en-GB")} tokens (the most it is allowed).`,
  tooMany: (n: number) => `Too many notes to send at once: ${n.toLocaleString("en-GB")}, and the most is ${SUMMARY_LIMITS.notes}. Select fewer notes: at least ${(n - SUMMARY_LIMITS.notes).toLocaleString("en-GB")} fewer.`,
  tooLong: (chars: number, fewer: number) =>
    `Too much to send at once: ${chars.toLocaleString("en-GB")} characters, and the most is ${SUMMARY_LIMITS.chars.toLocaleString("en-GB")}. Select fewer notes: at least ${fewer.toLocaleString("en-GB")} fewer.`,
  sending: "Sending the board to Anthropic.",
  receiving: "Receiving the summary.",
  waiting: "Waiting for Anthropic…",
  progress: (chars: number) => `Receiving… ${plural(chars, "character")}`,
  mayBill: "A request that was already sent can still be billed.",
  ready: (notes: number) => `Summary ready, from ${plural(notes, "note")}. Nothing is added to the board unless you choose Add to board.`,
  caution: "Written by AI from short notes. Check it against the board.",
  generated: (at: number, notes: number) => `Generated at ${clockTime(at)} from ${plural(notes, "note")}; the board may have changed since.`,
  notes: (n: number) => plural(n, "note"),
  showNote: "Show note",
  noteGone: "Note no longer on the board",
  tokens: (input: number, output: number) => `Used ${input.toLocaleString("en-GB")} input and ${output.toLocaleString("en-GB")} output tokens.`,
  unreadable: {
    title: "The summary couldn’t be read",
    message: "The reply wasn’t a summary the page could read. Nothing was changed on the board.",
    next: "Try again; a new request goes through the check page first.",
  },
  truncatedNext: "Select fewer notes, then try again.",
  stale: {
    reconnect: "The connection dropped while the summary was being made, so the board may have changed. Make a new summary to add one.",
    host: "You stopped being the host while the summary was being made. Only the host can add it.",
    silent: "A silent round started since this summary was made, so the board may have changed. Make a new summary to add one.",
  },
  blocked: (reason: string) => `Can’t add it now: ${reason}`,
  noRoom: (fails: readonly (readonly [string, number, number])[]) =>
    `The summary needs ${fails.map(([kind, needs, free]) => `${needs} ${needs === 1 ? kind.replace(/s$/, "") : kind}, but the board has room for ${free} more`).join("; ")}. Nothing was added.`,
  added: (notes: number) => `Added the summary: 1 frame and ${plural(notes, "note")}. One Undo removes all of it.`,
  notAdded: "Nothing was added. Close this to see why on the board.",
  addOnly: "Add to board only adds: one frame of notes, nothing replaced or cleared. One Undo removes all of it.",
  copied: "Copied the summary as Markdown.",
  copiedDocs: "Copied the summary for documents: paste it into a document to keep the headings and lists.",
  copiedPlain: "Copied the summary as plain text: this browser can’t copy formatting.",
  copyFailed: "Couldn’t copy: this browser didn’t allow it.",
  frameTitle: "AI summary (draft)",
} as const;

export type StaleKind = keyof typeof SUMMARY_TEXT.stale;

/** Why this page can't send the board now, or null: not connected, not the host, a silent round. */
export function summaryReason({ live, isHost, silent }: { live: boolean; isHost: boolean; silent: boolean }): string | null {
  if (!isHost) return SUMMARY_TEXT.hostOnly;
  if (!live) return SUMMARY_TEXT.offline;
  return silent ? SILENT_TEXT.on : null;
}

/** Why Add to board can't run now: Import's reasons, and the host rule (a lock never applies to a host). */
export function summaryAddReason({ live, isHost, lockedOut, silent, busy }: { live: boolean; isHost: boolean; lockedOut: boolean; silent: boolean; busy: boolean }): string | null {
  if (!live) return NOTE_TOOL_REASONS.disconnected;
  if (lockedOut) return LOCK_TEXT.reason;
  if (!isHost) return SUMMARY_TEXT.hostOnly;
  if (silent) return SILENT_TEXT.on;
  return busy ? UNDO_TEXT.busy : null;
}

/** Why this scope can't be sent: nothing in it, over 200 notes, or over 24,000 characters (with how many to deselect). */
export function summaryLimitReason(scope: SummaryScope): string | null {
  if (scope.noteCount === 0) return SUMMARY_TEXT.empty;
  if (scope.noteCount > SUMMARY_LIMITS.notes) return SUMMARY_TEXT.tooMany(scope.noteCount);
  const chars = summaryPayload(scope).length;
  if (chars <= SUMMARY_LIMITS.chars) return null;
  // The fewest notes to deselect: the longest first (each saves at least its own JSON entry).
  const sizes = scopeNotes(scope)
    .map((n) => JSON.stringify({ ref: n.ref, text: n.text }).replace(/</g, "\\u003c").length + 1)
    .sort((a, b) => b - a);
  let over = chars - SUMMARY_LIMITS.chars;
  let fewer = 0;
  for (const size of sizes) {
    if (over <= 0) break;
    over -= size;
    fewer++;
  }
  return SUMMARY_TEXT.tooLong(chars, fewer);
}

/** What Add to board needs: one frame, and a note for the overview, each theme, each action and the sentiment. */
export const summaryNeeds = (result: SummaryResult) => ({ notes: 2 + result.themes.length + result.actions.length, frames: 1 });

/** Room on the board for the summary, or why not (how many items fit). */
export function summaryRoomReason(needs: { notes: number; frames: number }, free: { notes: number; frames: number }): string | null {
  if (needs.notes <= free.notes && needs.frames <= free.frames) return null;
  return `The summary needs ${plural(needs.notes, "note")} and ${plural(needs.frames, "frame")}, but the board has room for ${more(free.notes, "note")} and ${more(free.frames, "frame")}.`;
}

/** The room's spare notes and frames (every note counts, the hidden ones of a silent round too). */
export const summaryFree = (used: { notes: number; frames: number }) => ({ notes: Math.max(0, MAX_NOTES_PER_ROOM - used.notes), frames: Math.max(0, MAX_FRAMES_PER_ROOM - used.frames) });

/** The summary's note colour: the one least used on the board, so it stands apart (purple first on a tie). */
const COLOUR_PREFERENCE: readonly NoteColor[] = ["purple", "blue", "green", "orange", "pink", "yellow"];
export function summaryColour(used: readonly NoteColor[]): NoteColor {
  const count = (c: NoteColor) => used.filter((u) => u === c).length;
  return [...COLOUR_PREFERENCE].filter((c) => (NOTE_COLORS as readonly string[]).includes(c)).sort((a, b) => count(a) - count(b))[0] ?? "purple";
}

/** "Positive 2 · Neutral 1 · Negative 2 · Mixed 0", plus "Not rated N" when there are any. */
export function countsLine(counts: SentimentCounts): string {
  const parts = (["positive", "neutral", "negative", "mixed"] as const).map((k) => `${SENTIMENT_NAMES[k]} ${counts[k]}`);
  if (counts.notRated > 0) parts.push(`${SENTIMENT_NAMES.notRated} ${counts.notRated}`);
  return parts.join(" · ");
}

/** A note's text: a title line and a body, within the note's 280 characters (the end cut with an ellipsis). */
function noteText(title: string, body: string): string {
  const text = body === "" ? title : `${title}\n${body}`;
  return codePointLength(text) <= MAX_NOTE_TEXT ? text : `${truncateCodePoints(text, MAX_NOTE_TEXT - 1).trimEnd()}…`;
}

/** The notes' texts, in order: the overview, each theme, each action, the sentiment. */
export function summaryNoteTexts(result: SummaryResult): string[] {
  const s = result.sentiment;
  return [
    noteText("Overview", result.overview),
    ...result.themes.map((t) => noteText(`Theme: ${t.title} (${SUMMARY_TEXT.notes(t.refs.length)})`, t.summary)),
    ...result.actions.map((a) => noteText("Possible action", a.text)),
    noteText(`Sentiment: ${s.overall ?? "not rated"}`, [countsLine(s.counts), s.reason].filter(Boolean).join("\n")),
  ];
}

const LAYOUT = { header: 64, pad: 24, gap: 24 } as const;

/**
 * What Add to board places: one frame titled "AI summary (draft)" holding the notes in a grid of
 * about square, all one colour. Import's content (refs, places from 0, 0), checked by the stencil
 * parser like every other add; frames go first, so the frame carries its notes.
 */
export function summaryContent(result: SummaryResult, _scope: SummaryScope, color: NoteColor): ImportContent {
  const texts = summaryNoteTexts(result);
  const { w, h } = NOTE_DEFAULTS;
  const cols = Math.ceil(Math.sqrt(texts.length));
  const rows = Math.ceil(texts.length / cols);
  const frame: StencilFrame = {
    ref: "f1",
    x: 0,
    y: 0,
    w: 2 * LAYOUT.pad + cols * w + (cols - 1) * LAYOUT.gap,
    h: LAYOUT.header + rows * h + (rows - 1) * LAYOUT.gap + LAYOUT.pad,
    title: SUMMARY_TEXT.frameTitle,
    color: "neutral",
    ...FRAME_DEFAULTS,
  };
  const notes: StencilNote[] = texts.map((text, i) => ({
    ref: `n${i + 1}`,
    x: LAYOUT.pad + (i % cols) * (w + LAYOUT.gap),
    y: LAYOUT.header + Math.floor(i / cols) * (h + LAYOUT.gap),
    ...NOTE_DEFAULTS,
    text,
    color,
  }));
  const stencil = parseStencil({ id: "summary", name: "AI summary", notes, shapes: [], frames: [frame], arrows: [], groups: [] });
  if (!stencil) throw new Error("summary content didn't pass the stencil check");
  return { ...stencil, stack: stencil.notes.map((n) => n.ref), cut: 0 };
}

/*
 * Copy as Markdown and Copy for documents (v0.44.0): one outline of the summary, three renderings.
 * Every model and board text is cleaned to one plain line first, then escaped for the format, so
 * nothing in it becomes a link, heading, list, HTML or markup. No refs and no Show note chips.
 */
/** A piece of text: our own (fixed) or the model's or the board's (`{ u }`, untrusted, cleaned to one line). */
type Piece = string | { u: string };
type Text = Piece[];
type ListItem = { lead?: Text; text: Text };
type Block = { kind: "h1" | "h2" | "h3" | "p" | "caution"; text: Text } | { kind: "list"; items: ListItem[] };

const u = (text: string): Piece => ({ u: cleanText(text) });

function summaryOutline(result: SummaryResult, scope: SummaryScope, at: Date): Block[] {
  const s = result.sentiment;
  const titleOf = new Map(scope.frames.map((f) => [f.ref, f.title]));
  const label = (l: SentimentLabel | null) => (l ? SENTIMENT_NAMES[l] : SENTIMENT_NAMES.notRated);
  const out: Block[] = [
    { kind: "h1", text: [SUMMARY_TEXT.frameTitle] },
    { kind: "caution", text: [SUMMARY_TEXT.caution] },
    { kind: "p", text: [SUMMARY_TEXT.generated(at.getTime(), scope.noteCount)] },
    { kind: "h2", text: ["Overview"] },
    { kind: "p", text: [u(result.overview)] },
  ];
  if (result.themes.length > 0) {
    out.push({ kind: "h2", text: ["Themes"] });
    out.push({
      kind: "list",
      items: result.themes.map((t) => ({ lead: [u(t.title)], text: [`(${SUMMARY_TEXT.notes(t.refs.length)})`, ...(t.summary ? [": ", u(t.summary)] : [])] })),
    });
  }
  out.push({ kind: "h2", text: ["Sentiment"] }, { kind: "p", text: [`Overall: ${label(s.overall)}.`, ...(s.reason ? [" ", u(s.reason)] : [])] });
  out.push({
    kind: "list",
    items: (["positive", "neutral", "negative", "mixed", "notRated"] as const).filter((k) => k !== "notRated" || s.counts.notRated > 0).map((k) => ({ text: [`${SENTIMENT_NAMES[k]}: ${s.counts[k]}`] })),
  });
  if (s.frames.length > 0) {
    out.push({ kind: "h3", text: ["By frame"] });
    out.push({ kind: "list", items: s.frames.map((f) => ({ text: [u(titleOf.get(f.ref) || "Untitled frame"), `: ${label(f.label)}`, ...(f.reason ? [" (", u(f.reason), ")"] : [])] })) });
  }
  if (result.actions.length > 0) {
    out.push({ kind: "h2", text: ["Possible actions"] }, { kind: "list", items: result.actions.map((a) => ({ text: [u(a.text)] })) });
  }
  return out;
}

/** Renders pieces: `escape` for untrusted text, `fixed` for our own. */
const render = (text: Text, escape: (s: string) => string, fixed: (s: string) => string = (x) => x) => text.map((p) => (typeof p === "string" ? fixed(p) : escape(p.u))).join("");

/** Copy as Markdown. */
export function summaryMarkdown(result: SummaryResult, scope: SummaryScope, at: Date): string {
  const md = (text: Text) => render(text, escapeInline);
  const lines = summaryOutline(result, scope, at).map((b) => {
    switch (b.kind) {
      case "h1":
        return `# ${md(b.text)}`;
      case "h2":
        return `## ${md(b.text)}`;
      case "h3":
        return `### ${md(b.text)}`;
      case "list":
        return b.items.map((i) => `- ${i.lead !== undefined ? `**${md(i.lead)}** ` : ""}${md(i.text)}`).join("\n");
      default:
        return md(b.text);
    }
  });
  return `${lines.join("\n\n")}\n`;
}

const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => ENTITIES[c]!);

/** Copy for documents, the formatted part: headings, paragraphs and lists only; every text escaped (ours too). */
export function summaryHtml(result: SummaryResult, scope: SummaryScope, at: Date): string {
  const h = (text: Text) => render(text, escapeHtml, escapeHtml);
  return summaryOutline(result, scope, at)
    .map((b) => {
      switch (b.kind) {
        case "h1":
        case "h2":
        case "h3":
          return `<${b.kind}>${h(b.text)}</${b.kind}>`;
        case "caution":
          return `<p><em>${h(b.text)}</em></p>`;
        case "list":
          return `<ul>${b.items.map((i) => `<li>${i.lead !== undefined ? `<strong>${h(i.lead)}</strong> ` : ""}${h(i.text)}</li>`).join("")}</ul>`;
        default:
          return `<p>${h(b.text)}</p>`;
      }
    })
    .join("");
}

/** Copy for documents, the plain part (and the fallback): no markup at all, bullets as "•". */
export function summaryPlainText(result: SummaryResult, scope: SummaryScope, at: Date): string {
  const t = (text: Text) => render(text, (x) => x);
  const blocks = summaryOutline(result, scope, at);
  const lines = blocks.map((b) => (b.kind === "list" ? b.items.map((i) => `• ${i.lead !== undefined ? `${t(i.lead)} ` : ""}${t(i.text)}`).join("\n") : t(b.text)));
  // A heading sits right above what it heads; other blocks are a blank line apart.
  const gap = (i: number) => (blocks[i - 1]!.kind === "h2" || blocks[i - 1]!.kind === "h3" ? "\n" : "\n\n");
  return `${lines.map((line, i) => (i === 0 ? line : `${gap(i)}${line}`)).join("")}\n`;
}
