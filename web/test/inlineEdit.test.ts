import { describe, expect, it } from "vitest";
import { MAX_NOTE_TEXT, codePointLength } from "@stickyard/shared";
import { INLINE_PLACEHOLDERS, fitsCap, inlineKeyAction, pasteInto, titleLine } from "../src/notes/inlineEdit";
import { joinTitleBody, splitTitleBody } from "../src/notes/titleBody";

/* Slice 2.9: editing a note in place. Pure helpers: keys, the 280 cap across both parts, paste. */

const key = (k: string, extra: Partial<{ shiftKey: boolean; isComposing: boolean }> = {}) => ({ key: k, shiftKey: false, isComposing: false, ...extra });

describe("title and body round trip", () => {
  it.each([
    ["", { title: "", body: "" }],
    ["Idea", { title: "Idea", body: "" }],
    ["Idea\nDetails", { title: "Idea", body: "Details" }],
    ["Idea\nLine one\nLine two", { title: "Idea", body: "Line one\nLine two" }],
    ["\nOnly a body", { title: "", body: "Only a body" }],
  ])("%j splits and joins back unchanged", (text, parts) => {
    expect(splitTitleBody(text)).toEqual(parts);
    expect(joinTitleBody(parts.title, parts.body)).toBe(text);
  });
});

describe("keys while editing in place", () => {
  it("title: Enter and Shift+Enter move to the body (the title is one line); Tab too", () => {
    expect(inlineKeyAction("title", key("Enter"))).toBe("body");
    expect(inlineKeyAction("title", key("Enter", { shiftKey: true }))).toBe("body");
    expect(inlineKeyAction("title", key("Tab"))).toBe("body");
    expect(inlineKeyAction("title", key("Tab", { shiftKey: true }))).toBe("stay");
  });

  it("body: Enter commits, Shift+Enter adds a line (the textarea's own), Shift+Tab goes back to the title", () => {
    expect(inlineKeyAction("body", key("Enter"))).toBe("commit");
    expect(inlineKeyAction("body", key("Enter", { shiftKey: true }))).toBeNull();
    expect(inlineKeyAction("body", key("Tab", { shiftKey: true }))).toBe("title");
    expect(inlineKeyAction("body", key("Tab"))).toBe("stay");
  });

  it("Escape commits from either part; other keys and IME composition are left alone", () => {
    expect(inlineKeyAction("title", key("Escape"))).toBe("commit");
    expect(inlineKeyAction("body", key("Escape"))).toBe("commit");
    expect(inlineKeyAction("title", key("n"))).toBeNull();
    expect(inlineKeyAction("body", key("Delete"))).toBeNull();
    expect(inlineKeyAction("body", key("Enter", { isComposing: true }))).toBeNull();
  });
});

describe("the 280-character cap across both parts", () => {
  it("counts title, the line break and body together, as the stored text", () => {
    expect(fitsCap("a".repeat(MAX_NOTE_TEXT), "")).toBe(true);
    expect(fitsCap("a".repeat(MAX_NOTE_TEXT), "b")).toBe(false);
    expect(fitsCap("a".repeat(139), "b".repeat(140))).toBe(true);
    expect(fitsCap("a".repeat(140), "b".repeat(140))).toBe(false);
    // Characters, not UTF-16 units.
    expect(fitsCap("😀".repeat(MAX_NOTE_TEXT), "")).toBe(true);
  });

  it("a title is one line: line breaks become spaces", () => {
    expect(titleLine("one\ntwo\r\nthree")).toBe("one two three");
  });
});

describe("paste", () => {
  it("inserts cleaned plain text at the selection, replacing it", () => {
    expect(pasteInto({ value: "Hello world", start: 6, end: 11, pasted: "there\u0000", part: "body", other: "" })).toEqual({ value: "Hello there", caret: 11 });
  });

  it("keeps line breaks in the body, not in the title", () => {
    expect(pasteInto({ value: "", start: 0, end: 0, pasted: "a\r\nb", part: "body", other: "" }).value).toBe("a\nb");
    expect(pasteInto({ value: "", start: 0, end: 0, pasted: "a\nb", part: "title", other: "" }).value).toBe("a b");
  });

  it("stops at the cap: only what fits is pasted", () => {
    const other = "b".repeat(200);
    const out = pasteInto({ value: "Title", start: 5, end: 5, pasted: "x".repeat(500), part: "title", other });
    expect(codePointLength(joinTitleBody(out.value, other))).toBe(MAX_NOTE_TEXT);
    expect(out.value.startsWith("Title")).toBe(true);
  });
});

describe("placeholders", () => {
  it("are helper text only, never note text", () => {
    expect(INLINE_PLACEHOLDERS).toEqual({ title: "Type a title", body: "Type body" });
    // Nothing typed: the note's text stays empty.
    expect(joinTitleBody("", "")).toBe("");
  });
});
