import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  NOTE_ALIGNS,
  NOTE_COLORS,
  NOTE_DEFAULTS,
  NOTE_DEFAULT_W,
  NOTE_FONT_SIZES,
  NOTE_MAX_W,
  NOTE_MIN_W,
  NOTE_TEXT_COLORS,
  type Note,
} from "@stickyard/shared";
import {
  NOTE_ALIGN_CLASSES,
  NOTE_ALIGN_NAMES,
  NOTE_FONT_SIZE_CLASSES,
  NOTE_FONT_SIZE_NAMES,
  NOTE_TEXT_COLOR_CLASSES,
  NOTE_TEXT_COLOR_NAMES,
  NOTE_PARTS,
  alignLabel,
  fontSizeToken,
  partStyle,
  partTextClasses,
  textColorToken,
} from "../src/notes/style";
import { PLACEHOLDER_ALPHA, PLACEHOLDER_CLASS } from "../src/notes/inlineEdit";

/* Style keys are never CSS: each maps to a token that exists in tokens.css (both themes for colours). */

const tokens = readFileSync(join(new URL("../src/", import.meta.url).pathname, "styles/tokens.css"), "utf8");

function theme(selector: string): Record<string, string> {
  const start = tokens.indexOf(selector);
  const block = tokens.slice(start, tokens.indexOf("}", start));
  return Object.fromEntries([...block.matchAll(/--sy-([\w-]+):\s*(#[0-9a-f]{6})\b/g)].map((m) => [m[1], m[2]]));
}
const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
};
const THEMES = [':root,\n[data-theme="light"]', '[data-theme="dark"]'];

describe("note text style tokens", () => {
  it("every font size key has a token and a Tailwind utility", () => {
    for (const key of NOTE_FONT_SIZES) {
      const name = fontSizeToken(key);
      expect(tokens, name).toMatch(new RegExp(`${name}:\\s*[\\d.]+rem;`));
      expect(NOTE_FONT_SIZE_CLASSES[key]).toBe(`text-note-${key}`);
      expect(tokens).toContain(`--text-note-${key}: var(${name});`);
      expect(NOTE_FONT_SIZE_NAMES[key]).toBeTruthy();
    }
  });

  it("font sizes grow with each step, and m is today's note text size", () => {
    const rem = (key: (typeof NOTE_FONT_SIZES)[number]) => Number(tokens.match(new RegExp(`${fontSizeToken(key)}:\\s*([\\d.]+)rem;`))?.[1]);
    const sizes = NOTE_FONT_SIZES.map(rem);
    expect(sizes).toEqual([...sizes].sort((a, b) => a - b));
    expect(new Set(sizes).size).toBe(sizes.length);
    expect(rem("m")).toBe(0.875);
  });

  it.each(THEMES)("every text colour key has a token in %s, readable on all six note colours", (selector) => {
    const c = theme(selector);
    for (const key of NOTE_TEXT_COLORS) {
      const name = textColorToken(key).replace(/^--sy-/, "");
      const fg = c[name];
      expect(fg, `${name} in ${selector}`).toBeDefined();
      for (const note of NOTE_COLORS) {
        expect(contrast(fg!, c[`note-${note}`]!), `${key} on ${note}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it.each(THEMES)("title and body: every ink either part can take is readable on all six note colours in %s", (selector) => {
    const c = theme(selector);
    const base: Note = { id: "NNNNNNNNNNNNNNNN", x: 0, y: 0, ...NOTE_DEFAULTS, text: "", color: "yellow", z: 0, rev: 1, authorId: "AAAAAAAAAAAAAAAA" };
    for (const part of NOTE_PARTS) {
      for (const ink of NOTE_TEXT_COLORS) {
        const note: Note = part === "title" ? { ...base, titleTextColor: ink } : { ...base, textColor: ink };
        expect(partStyle(note, part).textColor).toBe(ink);
        // The class the note renders with for that part resolves to the ink's token.
        const cls = partTextClasses(note, part).find((k) => k.startsWith("text-note-") && !/^text-note-(s|m|l|xl)$/.test(k));
        expect(cls, `${part} ${ink}`).toBe(NOTE_TEXT_COLOR_CLASSES[ink]);
        const fg = c[textColorToken(ink).replace(/^--sy-/, "")]!;
        for (const colour of NOTE_COLORS) {
          expect(contrast(fg, c[`note-${colour}`]!), `${part} ${ink} on ${colour}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  it("each part takes its own size, weight, slant, ink and alignment", () => {
    const note: Note = {
      id: "NNNNNNNNNNNNNNNN",
      x: 0,
      y: 0,
      ...NOTE_DEFAULTS,
      text: "",
      color: "yellow",
      z: 0,
      rev: 1,
      authorId: "AAAAAAAAAAAAAAAA",
      fontSize: "s",
      bold: false,
      italic: true,
      textColor: "green",
      align: "right",
      titleFontSize: "xl",
      titleBold: true,
      titleItalic: false,
      titleTextColor: "purple",
      titleAlign: "center",
    };
    expect(NOTE_PARTS).toEqual(["title", "body"]);
    expect(partStyle(note, "title")).toEqual({ fontSize: "xl", bold: true, italic: false, textColor: "purple", align: "center" });
    expect(partStyle(note, "body")).toEqual({ fontSize: "s", bold: false, italic: true, textColor: "green", align: "right" });
    expect(partTextClasses(note, "title").sort()).toEqual(["font-bold", "text-center", "text-note-text-purple", "text-note-xl"].sort());
    expect(partTextClasses(note, "body").sort()).toEqual(["italic", "text-note-s", "text-note-text-green", "text-right"].sort());
  });

  it.each(THEMES)("inline-edit placeholders are faint but readable (3:1) on every note colour in %s", (selector) => {
    const c = theme(selector);
    expect(PLACEHOLDER_CLASS).toBe(`placeholder:text-note-fg/${Math.round(PLACEHOLDER_ALPHA * 100)}`);
    const fg = c["note-fg"]!;
    const channel = (hex: string, i: number) => Number.parseInt(hex.slice(i, i + 2), 16);
    for (const note of NOTE_COLORS) {
      const bg = c[`note-${note}`]!;
      const mixed = `#${[1, 3, 5].map((i) => Math.round(channel(fg, i) * PLACEHOLDER_ALPHA + channel(bg, i) * (1 - PLACEHOLDER_ALPHA)).toString(16).padStart(2, "0")).join("")}`;
      expect(contrast(mixed, bg), `placeholder on ${note}`).toBeGreaterThanOrEqual(3);
    }
  });

  it("auto is the note foreground (today's look); every key has a utility and a name", () => {
    expect(textColorToken("auto")).toBe("--sy-note-fg");
    for (const key of NOTE_TEXT_COLORS) {
      expect(NOTE_TEXT_COLOR_NAMES[key]).toBeTruthy();
      const cls = NOTE_TEXT_COLOR_CLASSES[key];
      const token = textColorToken(key);
      expect(tokens).toContain(`--color-${cls.replace(/^text-/, "")}: var(${token});`);
    }
  });

  it("alignment keys map to text-align utilities", () => {
    expect(NOTE_ALIGNS.map((a) => NOTE_ALIGN_CLASSES[a])).toEqual(["text-left", "text-center", "text-right"]);
    for (const a of NOTE_ALIGNS) expect(NOTE_ALIGN_NAMES[a]).toBeTruthy();
    expect(NOTE_ALIGNS.map((a) => alignLabel("title", a))).toEqual(["Align title left", "Align title centre", "Align title right"]);
    expect(alignLabel("body", "right")).toBe("Align body right");
  });

  it("note size tokens match the shared constants", () => {
    expect(tokens).toContain(`--sy-note-size: ${NOTE_DEFAULT_W}px;`);
    expect(tokens).toContain(`--sy-note-min: ${NOTE_MIN_W}px;`);
    expect(tokens).toContain(`--sy-note-max: ${NOTE_MAX_W}px;`);
  });

  it("resize handles come from tokens: a small visible square and a touch-sized hit area", () => {
    expect(tokens).toMatch(/--sy-resize-handle:\s*\d+px;/);
    expect(tokens).toMatch(/--sy-resize-hit-fine:\s*\d+px;/);
  });
});
