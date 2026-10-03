import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NOTE_ALIGNS, NOTE_COLORS, NOTE_DEFAULT_W, NOTE_FONT_SIZES, NOTE_MAX_W, NOTE_MIN_W, NOTE_TEXT_COLORS } from "@stickyard/shared";
import {
  NOTE_ALIGN_CLASSES,
  NOTE_ALIGN_NAMES,
  NOTE_FONT_SIZE_CLASSES,
  NOTE_FONT_SIZE_NAMES,
  NOTE_TEXT_COLOR_CLASSES,
  NOTE_TEXT_COLOR_NAMES,
  fontSizeToken,
  textColorToken,
} from "../src/notes/style";

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
