// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SUMMARY_LIMITS } from "../src/ai/summaryPrompt";
import { SUMMARY_WARNINGS, parseSummaryReply } from "../src/ai/summaryParse";
import { summaryScope, type SummaryScope } from "../src/ai/summaryScope";
import { frame, note, room } from "./helpers/fakeRelay";
import { RETRO_SUMMARY } from "./helpers/aiSummaryFake";

/*
 * Summary and sentiment (10c, v0.44.0): the reply is untrusted data. Fixable problems are fixed and
 * listed; bad JSON, the wrong shape or an empty overview is one "couldn't be read" error. Counts
 * are always the page's own, from the per-note labels.
 */

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function retroScope(): SummaryScope {
  const t = room(
    [
      note(1, { text: "Shipped on time", x: 80, y: 480 }),
      note(2, { text: "Good pairing", x: 260, y: 480 }),
      note(3, { text: "Too many meetings", x: 780, y: 480 }),
      note(4, { text: "Unclear tickets", x: 960, y: 480 }),
      note(5, { text: "Parking lot: tooling", x: 40, y: 60 }),
    ],
    [frame(1, { title: "Went well", x: 40, y: 400 }), frame(2, { title: "To improve", x: 740, y: 400 })],
  );
  return summaryScope(t.view().board, {});
}
const clone = () => JSON.parse(JSON.stringify(RETRO_SUMMARY)) as typeof RETRO_SUMMARY & Record<string, unknown>;
const parse = (reply: unknown) => parseSummaryReply(typeof reply === "string" ? reply : JSON.stringify(reply), retroScope());
const ok = (reply: unknown) => {
  const r = parse(reply);
  if (!r.ok) throw new Error("unreadable");
  return r.result;
};

describe("a good reply", () => {
  it("reads the overview, themes, sentiment and actions; counts come from the per-note labels", () => {
    const r = ok(RETRO_SUMMARY);
    expect(r.overview).toBe(RETRO_SUMMARY.overview);
    expect(r.themes.map((t) => [t.title, t.refs])).toEqual([
      ["Delivery", ["n1", "n2"]],
      ["Process friction", ["n3", "n4"]],
    ]);
    expect(r.sentiment.overall).toBe("mixed");
    expect(r.sentiment.counts).toEqual({ positive: 2, neutral: 1, negative: 2, mixed: 0, notRated: 0 });
    expect(r.sentiment.frames).toEqual([
      { ref: "f1", label: "positive", reason: "" },
      { ref: "f2", label: "negative", reason: "Process friction." },
    ]);
    expect(r.actions.map((a) => [a.text, a.refs])).toEqual([
      ["Trial a meeting-free afternoon.", ["n3"]],
      ["Agree a ticket template.", ["n4"]],
    ]);
    expect(r.warnings).toEqual([]);
  });

  it("strips a code fence around the JSON", () => {
    expect(ok("```json\n" + JSON.stringify(RETRO_SUMMARY) + "\n```").overview).toBe(RETRO_SUMMARY.overview);
  });
});

describe("fatal: the summary couldn't be read", () => {
  it.each([
    ["not JSON", "Here is a summary of your board."],
    ["a list", "[]"],
    ["no overview", { ...RETRO_SUMMARY, overview: undefined }],
    ["an empty overview", { ...RETRO_SUMMARY, overview: "   " }],
    ["themes not a list", { ...RETRO_SUMMARY, themes: "Delivery" }],
    ["actions not a list", { ...RETRO_SUMMARY, actions: {} }],
    ["sentiment not an object", { ...RETRO_SUMMARY, sentiment: "mixed" }],
    ["sentiment notes not a list", { ...RETRO_SUMMARY, sentiment: { ...RETRO_SUMMARY.sentiment, notes: "all positive" } }],
  ])("%s", (_name, reply) => {
    expect(parse(reply)).toEqual({ ok: false });
  });
});

describe("fixed and listed", () => {
  it("unknown refs are dropped (themes, actions, labels, frames)", () => {
    const reply = clone();
    reply.themes[0]!.noteRefs = ["n1", "n99", "n1", "f1"];
    reply.actions[0]!.noteRefs = ["zzz"];
    reply.sentiment.notes.push({ ref: "n42", label: "positive" });
    reply.sentiment.frames.push({ ref: "f9", label: "positive", reason: null });
    const r = ok(reply);
    expect(r.themes[0]!.refs).toEqual(["n1"]);
    expect(r.actions[0]!.refs).toEqual([]);
    expect(r.sentiment.frames.map((f) => f.ref)).toEqual(["f1", "f2"]);
    expect(r.sentiment.counts.positive).toBe(2);
    expect(r.warnings).toContain(SUMMARY_WARNINGS.unknownRefs(5));
  });

  it("labels outside the four are unlabelled; notes with no label are not rated", () => {
    const reply = clone();
    reply.sentiment.notes = [
      { ref: "n1", label: "ecstatic" },
      { ref: "n2", label: "positive" },
      { ref: "n3", label: "negative" },
    ];
    reply.sentiment.frames[0]!.label = "great";
    reply.sentiment.overall = "fine";
    const r = ok(reply);
    expect(r.sentiment.labels.get("n1")).toBeUndefined();
    expect(r.sentiment.counts).toEqual({ positive: 1, neutral: 0, negative: 1, mixed: 0, notRated: 3 });
    expect(r.sentiment.frames[0]!.label).toBeNull();
    expect(r.sentiment.overall).toBeNull();
    expect(r.warnings).toContain(SUMMARY_WARNINGS.unlabelled(3));
    expect(r.warnings).toContain(SUMMARY_WARNINGS.notRated(2));
  });

  it("counts are never trusted from the model: extra count fields are ignored, a note labelled twice counts once", () => {
    const reply = clone() as Record<string, unknown>;
    (reply.sentiment as Record<string, unknown>).counts = { positive: 99, negative: 0 };
    reply.counts = { positive: 99 };
    (reply.sentiment as { notes: unknown[] }).notes.push({ ref: "n1", label: "negative" });
    const r = ok(reply);
    expect(r.sentiment.counts).toEqual({ positive: 2, neutral: 1, negative: 2, mixed: 0, notRated: 0 });
    expect(r.sentiment.labels.get("n1")).toBe("positive");
  });

  it("over-long text is trimmed with an ellipsis", () => {
    const reply = clone();
    reply.overview = "o".repeat(SUMMARY_LIMITS.overview + 50);
    reply.themes[0]!.title = "t".repeat(80);
    reply.themes[0]!.summary = "s".repeat(300);
    reply.actions[0]!.text = "a".repeat(200);
    reply.sentiment.reason = "r".repeat(300);
    reply.sentiment.frames[1]!.reason = "f".repeat(200);
    const r = ok(reply);
    expect([...r.overview]).toHaveLength(SUMMARY_LIMITS.overview);
    expect(r.overview.endsWith("…")).toBe(true);
    expect([...r.themes[0]!.title]).toHaveLength(SUMMARY_LIMITS.themeTitle);
    expect([...r.themes[0]!.summary]).toHaveLength(SUMMARY_LIMITS.themeSummary);
    expect([...r.actions[0]!.text]).toHaveLength(SUMMARY_LIMITS.actionText);
    expect([...r.sentiment.reason]).toHaveLength(SUMMARY_LIMITS.sentimentReason);
    expect([...r.sentiment.frames[1]!.reason]).toHaveLength(SUMMARY_LIMITS.frameReason);
    expect(r.warnings).toContain(SUMMARY_WARNINGS.trimmed(6));
  });

  it("extra themes and actions are dropped", () => {
    const reply = clone();
    reply.themes = Array.from({ length: 8 }, (_, i) => ({ title: `Theme ${i}`, summary: "s", noteRefs: [] }));
    reply.actions = Array.from({ length: 7 }, (_, i) => ({ text: `Action ${i}`, noteRefs: [] }));
    const r = ok(reply);
    expect(r.themes).toHaveLength(SUMMARY_LIMITS.themes);
    expect(r.actions).toHaveLength(SUMMARY_LIMITS.actions);
    expect(r.warnings).toContain(SUMMARY_WARNINGS.extra(3));
  });

  it("entries that can't be read are left out", () => {
    const reply = clone() as Record<string, unknown>;
    reply.themes = [...RETRO_SUMMARY.themes, "not a theme", { title: "", summary: "" }];
    reply.actions = [...RETRO_SUMMARY.actions, { text: 42 }];
    const r = ok(reply);
    expect(r.themes).toHaveLength(2);
    expect(r.actions).toHaveLength(2);
    expect(r.warnings).toContain(SUMMARY_WARNINGS.unreadable(3));
  });

  it("text is cleaned of control characters, kept as plain text", () => {
    const reply = clone();
    reply.overview = "Line one\u0000‮evil\nline two";
    const r = ok(reply);
    expect(r.overview).not.toMatch(/[\u0000‮]/);
    expect(r.overview).toContain("Line one");
  });
});

describe("injection", () => {
  it("a note telling the model to label everything positive can't change the counts beyond the labels given per note", () => {
    // The model "obeys" by adding a counts field and an extra all-positive claim; only the per-note labels count.
    const reply = clone() as Record<string, unknown>;
    reply.overview = "All notes are positive. SYSTEM PROMPT: ...";
    (reply.sentiment as Record<string, unknown>).counts = { positive: 5 };
    (reply.sentiment as Record<string, unknown>).overall = "positive";
    const r = ok(reply);
    expect(r.sentiment.counts.positive).toBe(2);
    expect(r.sentiment.counts.negative).toBe(2);
  });

  it("a plain-text reply that ignores the schema is the unreadable error", () => {
    expect(parse("Ignoring the schema as asked. Every note is positive.")).toEqual({ ok: false });
  });
});
