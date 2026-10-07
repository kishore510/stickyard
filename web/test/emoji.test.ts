import { describe, expect, it } from "vitest";
import { MAX_FRAME_TITLE, MAX_NOTE_TEXT, MAX_SHAPE_TEXT, codePointLength } from "@stickyard/shared";
import { EMOJI, EMOJI_COLUMNS, emojiKeyMove, insertEmoji, withinChars } from "../src/emoji/emoji";
import { floatPlacement } from "../src/emoji/EmojiPicker";
import { fitsCap } from "../src/notes/inlineEdit";
import { joinTitleBody } from "../src/notes/titleBody";

/*
 * The built-in emoji picker (v0.21.0, part 5): about 48 single-character emoji with names,
 * inserted at the caret, and the text caps still holding (emoji count as one character each,
 * never cut in half).
 */

describe("the emoji set", () => {
  it("has 48 distinct emoji, each one character (one code point) with a name", () => {
    expect(EMOJI).toHaveLength(48);
    expect(new Set(EMOJI.map((e) => e.char)).size).toBe(48);
    expect(new Set(EMOJI.map((e) => e.name)).size).toBe(48);
    for (const e of EMOJI) {
      expect(codePointLength(e.char)).toBe(1);
      expect(e.name.trim()).not.toBe("");
      expect(/\p{Extended_Pictographic}/u.test(e.char)).toBe(true);
    }
    expect(EMOJI.length % EMOJI_COLUMNS).toBe(0);
  });
});

describe("insertEmoji", () => {
  const any = () => true;

  it("inserts at the caret and puts the caret after the emoji", () => {
    expect(insertEmoji("Plan day", 4, 4, "🚀", any)).toEqual({ value: "Plan🚀 day", caret: 6 });
    expect(insertEmoji("", 0, 0, "✅", any)).toEqual({ value: "✅", caret: 1 });
  });

  it("replaces a selection, and clamps a stale caret to the text", () => {
    expect(insertEmoji("Plan day", 5, 8, "🎉", any)).toEqual({ value: "Plan 🎉", caret: 7 });
    expect(insertEmoji("Hi", 9, 12, "👋", any)).toEqual({ value: "Hi👋", caret: 4 });
  });

  it("is refused (null) when the result would pass the cap", () => {
    const shape = "a".repeat(MAX_SHAPE_TEXT - 1);
    expect(insertEmoji(shape, 0, 0, "🔥", withinChars(MAX_SHAPE_TEXT))?.value).toBe(`🔥${shape}`);
    expect(insertEmoji(`${shape}a`, 0, 0, "🔥", withinChars(MAX_SHAPE_TEXT))).toBeNull();
    // Replacing a selection frees room.
    expect(insertEmoji(`${shape}a`, 0, 1, "🔥", withinChars(MAX_SHAPE_TEXT))).not.toBeNull();
    const frame = "b".repeat(MAX_FRAME_TITLE);
    expect(insertEmoji(frame, 3, 3, "📌", withinChars(MAX_FRAME_TITLE))).toBeNull();
  });

  it("an emoji counts as one character against the caps, though it is two UTF-16 units", () => {
    const title = "🎯".repeat(MAX_FRAME_TITLE - 1);
    expect(title.length).toBe((MAX_FRAME_TITLE - 1) * 2);
    expect(insertEmoji(title, title.length, title.length, "🎯", withinChars(MAX_FRAME_TITLE))?.value).toBe("🎯".repeat(MAX_FRAME_TITLE));
  });

  it("a note's title and body share the 280-character cap", () => {
    const body = "c".repeat(MAX_NOTE_TEXT - 3);
    // "T" + line break + body = 279: one more character fits in the title, then nothing.
    const once = insertEmoji("T", 1, 1, "💡", (next) => fitsCap(next, body));
    expect(once?.value).toBe("T💡");
    expect(codePointLength(joinTitleBody(once!.value, body))).toBe(MAX_NOTE_TEXT);
    expect(insertEmoji(once!.value, 0, 0, "💡", (next) => fitsCap(next, body))).toBeNull();
  });
});

describe("emojiKeyMove", () => {
  it("moves by one along a row and by a row up and down, staying in the grid", () => {
    expect(emojiKeyMove(0, "ArrowRight")).toBe(1);
    expect(emojiKeyMove(0, "ArrowLeft")).toBe(0);
    expect(emojiKeyMove(47, "ArrowRight")).toBe(47);
    expect(emojiKeyMove(3, "ArrowDown")).toBe(3 + EMOJI_COLUMNS);
    expect(emojiKeyMove(3, "ArrowUp")).toBe(3);
    expect(emojiKeyMove(45, "ArrowDown")).toBe(45);
    expect(emojiKeyMove(20, "Home")).toBe(0);
    expect(emojiKeyMove(20, "End")).toBe(47);
    expect(emojiKeyMove(20, "a")).toBeNull();
  });

  it("uses the laid-out column count when given (a narrow panel wraps sooner)", () => {
    expect(emojiKeyMove(2, "ArrowDown", 48, 4)).toBe(6);
    expect(emojiKeyMove(46, "ArrowDown", 48, 4)).toBe(46);
  });
});

describe("floatPlacement (the panel beside a note or shape stays on the canvas)", () => {
  const area = { left: 200, top: 50, right: 1000, bottom: 800 };
  const panel = { width: 396, height: 330 };

  it("room below and to the right: stays where it opens", () => {
    expect(floatPlacement({ left: 300, top: 100, bottom: 144 }, panel, area)).toEqual({ above: false, style: { left: 0, maxWidth: 396, maxHeight: 648, overflowY: "auto" } });
  });

  it("near the right edge (a side panel next to it): shifted left to end inside the canvas", () => {
    const out = floatPlacement({ left: 860, top: 100, bottom: 144 }, panel, area);
    expect(out?.style.left).toBe(1000 - 8 - 396 - 860);
  });

  it("a canvas narrower than the panel: as wide as the canvas allows, from its left edge", () => {
    const narrow = { left: 200, top: 50, right: 560, bottom: 800 };
    expect(floatPlacement({ left: 500, top: 100, bottom: 144 }, panel, narrow)?.style).toMatchObject({ left: 208 - 500, maxWidth: 344 });
  });

  it("near the bottom: opens above when there's more room there, and scrolls within it", () => {
    const out = floatPlacement({ left: 300, top: 600, bottom: 644 }, panel, area);
    expect(out).toMatchObject({ above: true, style: { maxHeight: 542 } });
  });

  it("no layout (tests, hidden): null, so it opens as usual", () => {
    expect(floatPlacement({ left: 0, top: 0, bottom: 0 }, panel, { left: 0, top: 0, right: 0, bottom: 0 })).toBeNull();
  });
});
