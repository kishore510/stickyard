// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_NOTE_TEXT, codePointLength } from "@stickyard/shared";
import { parseSummaryReply, type SummaryResult } from "../src/ai/summaryParse";
import { SUMMARY_LIMITS } from "../src/ai/summaryPrompt";
import {
  SUMMARY_TEXT,
  summaryAddReason,
  summaryColour,
  summaryContent,
  summaryLimitReason,
  summaryMarkdown,
  summaryReason,
  summaryRoomReason,
} from "../src/ai/summaryRules";
import { summaryScope, type SummaryScope } from "../src/ai/summaryScope";
import { useSummary } from "../src/ai/summaryStore";
import { LOCK_TEXT } from "../src/facilitation/lock";
import { SILENT_TEXT } from "../src/silent/silent";
import { UNDO_TEXT } from "../src/rooms/session";
import { NOTE_TOOL_REASONS } from "../src/canvas/tools";
import { frame, note, room } from "./helpers/fakeRelay";
import { RETRO_SUMMARY } from "./helpers/aiSummaryFake";

/*
 * Summary and sentiment (10c, v0.44.0): who can use it and when (host only, never during a silent
 * round), the caps, what Add to board puts on the board, and Copy as Markdown.
 */

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function retro(): { scope: SummaryScope; result: SummaryResult } {
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
  const scope = summaryScope(t.view().board, {});
  const parsed = parseSummaryReply(JSON.stringify(RETRO_SUMMARY), scope);
  if (!parsed.ok) throw new Error("unreadable");
  return { scope, result: parsed.result };
}

describe("who can send the board", () => {
  it("only the host; never during a silent round; needs a connection", () => {
    expect(summaryReason({ live: true, isHost: false, silent: false })).toBe("Only the host can send the board to AI.");
    expect(summaryReason({ live: true, isHost: false, silent: true })).toBe("Only the host can send the board to AI.");
    expect(summaryReason({ live: true, isHost: true, silent: true })).toBe("Silent brainstorm is on.");
    expect(SILENT_TEXT.on).toBe("Silent brainstorm is on.");
    expect(summaryReason({ live: false, isHost: true, silent: false })).toBe(SUMMARY_TEXT.offline);
    expect(summaryReason({ live: true, isHost: true, silent: false })).toBeNull();
  });

  it("Add to board: the host (a lock never applies), not during a silent round or another add; a guest on a locked board is refused", () => {
    const base = { live: true, isHost: true, lockedOut: false, silent: false, busy: false };
    expect(summaryAddReason(base)).toBeNull();
    expect(summaryAddReason({ ...base, isHost: false })).toBe("Only the host can send the board to AI.");
    expect(summaryAddReason({ ...base, isHost: false, lockedOut: true })).toBe(LOCK_TEXT.reason);
    expect(summaryAddReason({ ...base, silent: true })).toBe(SILENT_TEXT.on);
    expect(summaryAddReason({ ...base, busy: true })).toBe(UNDO_TEXT.busy);
    expect(summaryAddReason({ ...base, live: false })).toBe(NOTE_TOOL_REASONS.disconnected);
  });
});

describe("caps", () => {
  it("nothing to summarise", () => {
    expect(summaryLimitReason(summaryScope(room().view().board, {}))).toBe("Nothing to summarise.");
  });

  it("over 24,000 characters: Send is off and it says how many notes to deselect", () => {
    const notes = Array.from({ length: 100 }, (_, i) => note(i + 1, { text: `${i} ${"word ".repeat(60)}`.slice(0, MAX_NOTE_TEXT), x: (i % 10) * 200, y: Math.floor(i / 10) * 200 }));
    const scope = summaryScope(room(notes).view().board, {});
    const reason = summaryLimitReason(scope);
    expect(reason).toMatch(/^Too much to send at once: [\d,]+ characters, and the most is 24,000\. Select fewer notes: at least \d+ fewer\.$/);
    const fewer = Number(/at least (\d+) fewer/.exec(reason!)![1]);
    // Deselecting that many (the longest) brings it under the cap; one fewer doesn't.
    expect(fewer).toBeGreaterThan(0);
    const under = summaryScope(room(notes.slice(fewer)).view().board, {});
    expect(summaryLimitReason(under)).toBeNull();
    const still = summaryScope(room(notes.slice(fewer - 1)).view().board, {});
    expect(summaryLimitReason(still)).not.toBeNull();
    expect(SUMMARY_LIMITS.chars).toBe(24_000);
  });

  it("a small board is within the caps", () => {
    expect(summaryLimitReason(retro().scope)).toBeNull();
  });
});

describe("Add to board content", () => {
  it("one frame titled AI summary (draft), first, holding a note for the overview, each theme, each action and the sentiment", () => {
    const { scope, result } = retro();
    const content = summaryContent(result, scope, "purple");
    expect(content.frames).toHaveLength(1);
    expect(content.frames[0]!.title).toBe("AI summary (draft)");
    expect(content.notes).toHaveLength(1 + 2 + 2 + 1);
    expect(content.shapes).toEqual([]);
    expect(content.arrows).toEqual([]);
    expect(new Set(content.notes.map((n) => n.color))).toEqual(new Set(["purple"]));
    const texts = content.notes.map((n) => n.text);
    expect(texts[0]).toBe(`Overview\n${RETRO_SUMMARY.overview}`);
    expect(texts[1]).toBe("Theme: Delivery (2 notes)\nShipping on time and pairing went well.");
    expect(texts).toContain("Possible action\nTrial a meeting-free afternoon.");
    expect(texts.at(-1)).toBe("Sentiment: mixed\nPositive 2 · Neutral 1 · Negative 2 · Mixed 0\nWins on delivery, friction in the process.");
    // Every note sits inside the frame, below its title.
    const f = content.frames[0]!;
    for (const n of content.notes) {
      expect(n.x).toBeGreaterThanOrEqual(f.x);
      expect(n.y).toBeGreaterThanOrEqual(f.y + 64);
      expect(n.x + n.w).toBeLessThanOrEqual(f.x + f.w);
      expect(n.y + n.h).toBeLessThanOrEqual(f.y + f.h);
    }
  });

  it("a not-rated count shows when there is one", () => {
    const { scope, result } = retro();
    const content = summaryContent({ ...result, sentiment: { ...result.sentiment, counts: { ...result.sentiment.counts, notRated: 2 } } }, scope, "blue");
    expect(content.notes.at(-1)!.text).toContain("Not rated 2");
  });

  it("note texts stay within 280 characters, trimmed with an ellipsis", () => {
    const { scope, result } = retro();
    const long = { ...result, overview: "o".repeat(600), themes: result.themes.map((t) => ({ ...t, summary: "s".repeat(240), title: "t".repeat(60) })) };
    const content = summaryContent(long, scope, "purple");
    for (const n of content.notes) expect(codePointLength(n.text)).toBeLessThanOrEqual(MAX_NOTE_TEXT);
    expect(content.notes[0]!.text.endsWith("…")).toBe(true);
  });

  it("the colour is the one least used on the board (purple first on a tie)", () => {
    expect(summaryColour(["yellow", "yellow", "pink"])).toBe("purple");
    expect(summaryColour(["purple", "blue", "green", "orange", "pink", "yellow", "purple"])).toBe("blue");
  });

  it("capacity: says how many items fit when the board has no room", () => {
    expect(summaryRoomReason({ notes: 6, frames: 1 }, { notes: 200, frames: 30 })).toBeNull();
    expect(summaryRoomReason({ notes: 6, frames: 1 }, { notes: 4, frames: 30 })).toBe("The summary needs 6 notes and 1 frame, but the board has room for 4 more notes and 30 more frames.");
    expect(summaryRoomReason({ notes: 6, frames: 1 }, { notes: 10, frames: 0 })).toBe("The summary needs 6 notes and 1 frame, but the board has room for 10 more notes and no more frames.");
  });
});

describe("Copy as Markdown", () => {
  it("has the caution line and every part, and escapes model and board text", () => {
    const { scope, result } = retro();
    const md = summaryMarkdown(result, scope, new Date(2026, 9, 17, 9, 5));
    expect(md).toContain("# AI summary (draft)");
    expect(md).toContain("Written by AI from short notes. Check it against the board.");
    expect(md).toContain("Generated at 09:05 from 5 notes; the board may have changed since.");
    expect(md).toContain("## Overview");
    expect(md).toContain("## Themes");
    expect(md).toContain("- **Delivery** (2 notes): Shipping on time and pairing went well.");
    expect(md).toContain("## Sentiment");
    expect(md).toContain("Overall: Mixed. Wins on delivery, friction in the process.");
    expect(md).toContain("- Positive: 2");
    expect(md).toContain("- Went well: Positive");
    expect(md).toContain("## Possible actions");
    const evil = { ...result, overview: "[click](https://example.com) <img src=x onerror=alert(1)> # heading" };
    const out = summaryMarkdown(evil, scope, new Date(2026, 9, 17, 9, 5));
    expect(out).not.toContain("[click](");
    expect(out).not.toMatch(/(^|[^\\])<img/);
    expect(out).toContain("\\<img");
    expect(out).toContain("\\[click\\]");
  });
});

describe("the store", () => {
  it("a silent round, a host change or a reconnect during the wait or after the result disables Add (and is kept until the next send)", () => {
    const s = useSummary.getState();
    s.reset();
    s.invalidate("silent");
    expect(useSummary.getState().stale).toBeNull();
    s.setPending(true);
    s.invalidate("silent");
    expect(useSummary.getState().stale).toBe(SUMMARY_TEXT.stale.silent);
    s.invalidate("host");
    expect(useSummary.getState().stale).toBe(SUMMARY_TEXT.stale.silent);
    s.startSend();
    expect(useSummary.getState().stale).toBeNull();
    s.reset();
  });
});
