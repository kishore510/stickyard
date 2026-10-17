import { codePointLength, truncateCodePoints } from "@stickyard/shared";
import { cleanText } from "../export/markdown";
import { SENTIMENT_LABELS, SUMMARY_LIMITS, type SentimentLabel } from "./summaryPrompt";
import { scopeNotes, type SummaryScope } from "./summaryScope";

/*
 * Summary and sentiment (v0.44.0): the model's reply, read as untrusted data. Code fences are
 * stripped and JSON.parse is the only reader; then the shape and the caps. Fixable problems are
 * fixed and listed as warnings (unknown refs dropped, labels outside the four unlabelled, notes
 * with no label not rated, over-long text trimmed with an ellipsis, extra themes and actions
 * dropped). Bad JSON, the wrong shape or an empty overview is one "couldn't be read" error.
 * Counts are always computed here from the per-note labels; any count in the reply is ignored.
 * Text is cleaned to one plain line (controls and bidi overrides gone) and is only ever shown as text.
 */

export type SentimentCounts = Record<SentimentLabel | "notRated", number>;

export interface SummaryTheme {
  title: string;
  summary: string;
  /** Note refs, known and once each. */
  refs: string[];
}
export interface SummaryAction {
  text: string;
  refs: string[];
}
export interface FrameSentiment {
  ref: string;
  /** null: unlabelled (the reply's label wasn't one of the four). */
  label: SentimentLabel | null;
  reason: string;
}
export interface SummaryResult {
  overview: string;
  themes: SummaryTheme[];
  sentiment: {
    overall: SentimentLabel | null;
    reason: string;
    /** Each labelled note ref's label (the first one given). */
    labels: Map<string, SentimentLabel>;
    /** The page's own counts over every note in scope. */
    counts: SentimentCounts;
    /** Known frames, in the reply's order, once each. */
    frames: FrameSentiment[];
  };
  actions: SummaryAction[];
  warnings: string[];
}

export type SummaryParse = { ok: true; result: SummaryResult } | { ok: false };

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const was = (n: number) => (n === 1 ? "was" : "were");

export const SUMMARY_WARNINGS = {
  unknownRefs: (n: number) => `${plural(n, "reference", "references")} to notes or frames that aren’t in the summary ${was(n)} dropped.`,
  unlabelled: (n: number) => `${plural(n, "label", "labels")} outside positive, neutral, negative and mixed ${was(n)} left unlabelled.`,
  notRated: (n: number) => `${plural(n, "note", "notes")} got no label and ${n === 1 ? "is" : "are"} counted as not rated.`,
  trimmed: (n: number) => `${plural(n, "text", "texts")} ${was(n)} longer than allowed and ${was(n)} trimmed.`,
  extra: (n: number) => `${plural(n, "theme or action", "themes or actions")} beyond the limit of ${SUMMARY_LIMITS.themes} each ${was(n)} dropped.`,
  unreadable: (n: number) => `${plural(n, "entry", "entries")} couldn’t be read and ${was(n)} left out.`,
} as const;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isLabel = (v: unknown): v is SentimentLabel => (SENTIMENT_LABELS as readonly unknown[]).includes(v);

/** The text without a Markdown code fence around it. */
function withoutFences(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```[^\n]*\n?([\s\S]*?)\n?```$/.exec(trimmed);
  return (fenced ? fenced[1]! : trimmed).trim();
}

/** One plain line, at most `max` characters (the last one an ellipsis when cut). */
export function trimText(raw: string, max: number): { text: string; cut: boolean } {
  const clean = cleanText(raw);
  if (codePointLength(clean) <= max) return { text: clean, cut: false };
  return { text: `${truncateCodePoints(clean, max - 1).trimEnd()}…`, cut: true };
}

/** The reply as a summary to show, or "couldn't be read". `scope` gives the refs that exist. */
export function parseSummaryReply(text: string, scope: SummaryScope): SummaryParse {
  const unreadable: SummaryParse = { ok: false };
  let raw: unknown;
  try {
    raw = JSON.parse(withoutFences(text));
  } catch {
    return unreadable;
  }
  if (!isRecord(raw) || typeof raw.overview !== "string") return unreadable;
  const rawThemes = raw.themes ?? [];
  const rawActions = raw.actions ?? [];
  const rawSentiment = raw.sentiment ?? {};
  if (!Array.isArray(rawThemes) || !Array.isArray(rawActions) || !isRecord(rawSentiment)) return unreadable;
  const rawLabels = rawSentiment.notes ?? [];
  const rawFrames = rawSentiment.frames ?? [];
  if (!Array.isArray(rawLabels) || !Array.isArray(rawFrames)) return unreadable;

  const counts = { unknownRefs: 0, unlabelled: 0, trimmed: 0, extra: 0, unreadable: 0 };
  const take = (value: unknown, max: number): string => {
    const t = trimText(typeof value === "string" ? value : "", max);
    if (t.cut) counts.trimmed++;
    return t.text;
  };

  const overview = take(raw.overview, SUMMARY_LIMITS.overview);
  if (overview === "") return unreadable;

  const noteRefs = new Set(scopeNotes(scope).map((n) => n.ref));
  const frameRefs = new Set(scope.frames.map((f) => f.ref));
  const knownRefs = (value: unknown): string[] => {
    const out: string[] = [];
    for (const ref of Array.isArray(value) ? value : []) {
      if (typeof ref !== "string" || !noteRefs.has(ref)) counts.unknownRefs++;
      else if (!out.includes(ref)) out.push(ref);
    }
    return out;
  };

  const themes: SummaryTheme[] = [];
  for (const t of rawThemes) {
    if (!isRecord(t) || typeof t.title !== "string" || (t.title.trim() === "" && (typeof t.summary !== "string" || t.summary.trim() === ""))) {
      counts.unreadable++;
      continue;
    }
    if (themes.length >= SUMMARY_LIMITS.themes) {
      counts.extra++;
      continue;
    }
    themes.push({ title: take(t.title, SUMMARY_LIMITS.themeTitle), summary: take(t.summary, SUMMARY_LIMITS.themeSummary), refs: knownRefs(t.noteRefs) });
  }

  const actions: SummaryAction[] = [];
  for (const a of rawActions) {
    if (!isRecord(a) || typeof a.text !== "string" || a.text.trim() === "") {
      counts.unreadable++;
      continue;
    }
    if (actions.length >= SUMMARY_LIMITS.actions) {
      counts.extra++;
      continue;
    }
    actions.push({ text: take(a.text, SUMMARY_LIMITS.actionText), refs: knownRefs(a.noteRefs) });
  }

  // Per-note labels: known refs only, the first label each; anything else is unlabelled.
  const labels = new Map<string, SentimentLabel>();
  const seen = new Set<string>();
  for (const entry of rawLabels) {
    if (!isRecord(entry) || typeof entry.ref !== "string" || !noteRefs.has(entry.ref)) {
      counts.unknownRefs++;
      continue;
    }
    if (seen.has(entry.ref)) continue;
    seen.add(entry.ref);
    if (isLabel(entry.label)) labels.set(entry.ref, entry.label);
    else counts.unlabelled++;
  }
  const sentimentCounts: SentimentCounts = { positive: 0, neutral: 0, negative: 0, mixed: 0, notRated: 0 };
  for (const ref of noteRefs) {
    const l = labels.get(ref);
    sentimentCounts[l ?? "notRated"]++;
  }
  const missing = [...noteRefs].filter((ref) => !seen.has(ref)).length;

  const frames: FrameSentiment[] = [];
  for (const entry of rawFrames) {
    if (!isRecord(entry) || typeof entry.ref !== "string" || !frameRefs.has(entry.ref)) {
      counts.unknownRefs++;
      continue;
    }
    if (frames.some((f) => f.ref === entry.ref)) continue;
    if (!isLabel(entry.label)) counts.unlabelled++;
    frames.push({ ref: entry.ref, label: isLabel(entry.label) ? entry.label : null, reason: take(entry.reason, SUMMARY_LIMITS.frameReason) });
  }

  const overall = isLabel(rawSentiment.overall) ? rawSentiment.overall : null;
  if (!overall) counts.unlabelled++;
  const reason = take(rawSentiment.reason, SUMMARY_LIMITS.sentimentReason);

  const warnings: string[] = [];
  if (counts.unreadable > 0) warnings.push(SUMMARY_WARNINGS.unreadable(counts.unreadable));
  if (counts.extra > 0) warnings.push(SUMMARY_WARNINGS.extra(counts.extra));
  if (counts.unknownRefs > 0) warnings.push(SUMMARY_WARNINGS.unknownRefs(counts.unknownRefs));
  if (counts.unlabelled > 0) warnings.push(SUMMARY_WARNINGS.unlabelled(counts.unlabelled));
  if (missing > 0) warnings.push(SUMMARY_WARNINGS.notRated(missing));
  if (counts.trimmed > 0) warnings.push(SUMMARY_WARNINGS.trimmed(counts.trimmed));

  return {
    ok: true,
    result: { overview, themes, sentiment: { overall, reason, labels, counts: sentimentCounts, frames }, actions, warnings },
  };
}
