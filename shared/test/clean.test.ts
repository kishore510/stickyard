import { describe, expect, it } from "vitest";
import { MAX_NAME_LENGTH, MAX_TEXT_LENGTH, cleanName, cleanText, codePointLength } from "../src/index";

describe("cleanName", () => {
  it.each([
    ["plain", "Alex", "Alex"],
    ["trims", "  Alex  ", "Alex"],
    ["collapses inner whitespace", "Alex   B  Smith", "Alex B Smith"],
    ["tabs and newlines become one space", "Alex\t\n\r Smith", "Alex Smith"],
    ["unicode spaces", "Alex  Smith", "Alex Smith"],
    ["line and paragraph separators", "Alex  Smith", "Alex Smith"],
    ["strips C0 controls", "A\u0000l\u0007e\u001Bx", "Alex"],
    ["strips DEL and C1 controls", "Al\u007Fe\u0085x\u009F", "Alex"],
    ["strips zero-width space, joiner, non-joiner, BOM, word joiner", "A​l‌e‍x﻿⁠", "Alex"],
    ["strips bidi overrides and embeddings", "‮Alex‬‪‫‭", "Alex"],
    ["strips bidi isolates and marks", "⁦A⁧l⁨e⁩x‎‏؜", "Alex"],
    ["a stripped char between spaces leaves one space", "Alex ​ Smith", "Alex Smith"],
    ["keeps accents and other scripts", "Zoë 李 Øyvind", "Zoë 李 Øyvind"],
    ["keeps emoji", "Alex 😀", "Alex 😀"],
    ["keeps HTML-looking text as text", "<b>Alex</b>", "<b>Alex</b>"],
    ["exactly the max length", "x".repeat(MAX_NAME_LENGTH), "x".repeat(MAX_NAME_LENGTH)],
    ["max length counted in characters, not UTF-16 units", "😀".repeat(MAX_NAME_LENGTH), "😀".repeat(MAX_NAME_LENGTH)],
    ["long only before cleaning", ` ${"x".repeat(MAX_NAME_LENGTH)}​​ `, "x".repeat(MAX_NAME_LENGTH)],
  ])("%s", (_label, input, expected) => {
    expect(cleanName(input)).toBe(expected);
  });

  it.each([
    ["empty", ""],
    ["only spaces", "   "],
    ["only invisible characters", "​‮⁦﻿"],
    ["only controls", "\u0000\u0001\u0007"],
    ["one over the max length", "x".repeat(MAX_NAME_LENGTH + 1)],
    ["over the max in emoji", "😀".repeat(MAX_NAME_LENGTH + 1)],
  ])("rejects %s", (_label, input) => {
    expect(cleanName(input)).toBeNull();
  });

  it("is idempotent", () => {
    const once = cleanName("  ‮A  l​ex ");
    expect(once).not.toBeNull();
    expect(cleanName(once ?? "")).toBe(once);
  });
});

describe("cleanText", () => {
  it("cleans like a name", () => {
    expect(cleanText("  hello ‮  world​ ")).toBe("hello world");
  });

  it("accepts up to the max length", () => {
    expect(cleanText("y".repeat(MAX_TEXT_LENGTH))).toBe("y".repeat(MAX_TEXT_LENGTH));
  });

  it.each([
    ["empty", ""],
    ["whitespace only", " \n\t "],
    ["invisible only", "​⁦"],
    ["over the max length", "y".repeat(MAX_TEXT_LENGTH + 1)],
  ])("rejects %s", (_label, input) => {
    expect(cleanText(input)).toBeNull();
  });
});

describe("codePointLength", () => {
  it("counts characters, not UTF-16 units", () => {
    expect(codePointLength("abc")).toBe(3);
    expect(codePointLength("😀😀")).toBe(2);
  });
});
