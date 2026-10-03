import { describe, expect, it } from "vitest";
import {
  NOTE_DEFAULTS,
  NOTE_EDIT_FIELDS,
  NOTE_FONT_SIZES,
  NOTE_TEXT_COLORS,
  PROTOCOL_VERSION,
  clientMessageSchema,
  serverMessageSchema,
  type Note,
} from "../src/index";

/*
 * Protocol v6 (slice 2.7.2): the title (a note's first line) has its own size, bold, italic and
 * text colour, apart from the body's (fontSize, bold, italic, textColor). Fixtures are generic.
 */

const NOTE_ID = "NNNNNNNNNNNNNNNN";
const note: Note = { id: NOTE_ID, x: 1, y: 2, ...NOTE_DEFAULTS, text: "Idea one\nThe details", color: "yellow", rev: 1, authorId: "AAAAAAAAAAAAAAAA" };
const edit = (fields: Record<string, unknown>) => clientMessageSchema.safeParse({ type: "noteEdit", id: NOTE_ID, ...fields }).success;

const TITLE_FIELDS = ["titleFontSize", "titleBold", "titleItalic", "titleTextColor"] as const;

describe("title style (protocol v6)", () => {
  it("is protocol 6, and the title's defaults match the body's", () => {
    expect(PROTOCOL_VERSION).toBe(6);
    expect(NOTE_DEFAULTS.titleFontSize).toBe(NOTE_DEFAULTS.fontSize);
    expect(NOTE_DEFAULTS.titleBold).toBe(NOTE_DEFAULTS.bold);
    expect(NOTE_DEFAULTS.titleItalic).toBe(NOTE_DEFAULTS.italic);
    expect(NOTE_DEFAULTS.titleTextColor).toBe(NOTE_DEFAULTS.textColor);
    for (const field of TITLE_FIELDS) expect(NOTE_EDIT_FIELDS).toContain(field);
  });

  it.each(NOTE_FONT_SIZES)("noteEdit accepts titleFontSize %s on its own", (titleFontSize) => {
    expect(edit({ titleFontSize })).toBe(true);
  });

  it.each(NOTE_TEXT_COLORS)("noteEdit accepts titleTextColor %s on its own", (titleTextColor) => {
    expect(edit({ titleTextColor })).toBe(true);
  });

  it("noteEdit accepts titleBold and titleItalic, and title and body style together", () => {
    expect(edit({ titleBold: true })).toBe(true);
    expect(edit({ titleItalic: false })).toBe(true);
    expect(edit({ titleFontSize: "xl", fontSize: "s", titleBold: true, bold: false, titleTextColor: "red", textColor: "blue" })).toBe(true);
  });

  it.each([
    ["titleFontSize", "huge"],
    ["titleFontSize", "16px"],
    ["titleFontSize", "XL"],
    ["titleTextColor", "#ff0000"],
    ["titleTextColor", "Red"],
    ["titleBold", "true"],
    ["titleBold", 1],
    ["titleItalic", null],
  ])("noteEdit rejects %s = %j", (field, value) => {
    expect(edit({ [field]: value })).toBe(false);
  });

  it("an empty edit is refused (no field at all, or only the id)", () => {
    expect(edit({})).toBe(false);
    expect(edit({ titleBold: undefined })).toBe(false);
  });

  it("unknown keys are refused (strict), including near-misses of the new fields", () => {
    expect(edit({ titleBold: true, titleUnderline: true })).toBe(false);
    expect(edit({ titleSize: "l" })).toBe(false);
    expect(edit({ titleColor: "red" })).toBe(false);
    expect(edit({ titleBold: true, rev: 9 })).toBe(false);
  });

  it("a note on the wire must have every title field (a v5 note without them is refused)", () => {
    expect(serverMessageSchema.safeParse({ type: "noteUpdated", note }).success).toBe(true);
    const styled = { ...note, titleFontSize: "xl", titleBold: true, titleItalic: true, titleTextColor: "purple" };
    expect(serverMessageSchema.safeParse({ type: "noteUpdated", note: styled }).success).toBe(true);
    for (const field of TITLE_FIELDS) {
      const { [field]: _drop, ...v5 } = note;
      expect(serverMessageSchema.safeParse({ type: "noteUpdated", note: v5 }).success, field).toBe(false);
    }
    expect(serverMessageSchema.safeParse({ type: "noteUpdated", note: { ...note, titleFontSize: "16px" } }).success).toBe(false);
    expect(serverMessageSchema.safeParse({ type: "noteUpdated", note: { ...note, titleTextColor: "#000000" } }).success).toBe(false);
  });
});
