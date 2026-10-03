import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BOARD_HEIGHT, BOARD_WIDTH, NOTE_COLORS, NOTE_SIZE, PALETTE_SIZE } from "@stickyard/shared";
import { BREAKPOINTS } from "../src/styles/breakpoints";

const SRC = new URL("../src/", import.meta.url).pathname;
const tokens = readFileSync(join(SRC, "styles/tokens.css"), "utf8");

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });

/** The colour block for one theme, as { name: hex }. */
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

describe("design tokens", () => {
  it("breakpoints in script match tokens.css", () => {
    for (const [name, value] of Object.entries(BREAKPOINTS)) expect(tokens).toContain(`--breakpoint-${name}: ${value};`);
  });

  it.each([':root,\n[data-theme="light"]', '[data-theme="dark"]'])("text and accent contrast in %s", (selector) => {
    const c = theme(selector);
    for (const bg of ["bg", "surface", "surface-muted"]) {
      expect(contrast(c.fg!, c[bg]!), `fg on ${bg}`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(c["fg-muted"]!, c[bg]!), `fg-muted on ${bg}`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(c.accent!, c[bg]!), `accent on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(c["accent-fg"]!, c.accent!), "accent-fg on accent").toBeGreaterThanOrEqual(4.5);
  });

  it.each([':root,\n[data-theme="light"]', '[data-theme="dark"]'])(
    "participant colours: one per palette slot in %s, each visible on the page and on cards",
    (selector) => {
      const c = theme(selector);
      const names = Object.keys(c).filter((n) => /^participant-\d+$/.test(n));
      expect(names).toEqual(Array.from({ length: PALETTE_SIZE }, (_, i) => `participant-${i + 1}`));
      for (const name of names) {
        // Non-text graphics need 3:1 (WCAG 1.4.11). The name is always shown next to the dot.
        expect(contrast(c[name]!, c.surface!), `${name} on surface`).toBeGreaterThanOrEqual(3);
        expect(contrast(c[name]!, c.bg!), `${name} on bg`).toBeGreaterThanOrEqual(3);
      }
    },
  );

  it("participant colours are mapped to Tailwind utilities", () => {
    for (let i = 1; i <= PALETTE_SIZE; i++) expect(tokens).toContain(`--color-participant-${i}: var(--sy-participant-${i});`);
  });

  it.each([':root,\n[data-theme="light"]', '[data-theme="dark"]'])("every note colour, readable with note text, in %s", (selector) => {
    const c = theme(selector);
    for (const key of NOTE_COLORS) {
      const bg = c[`note-${key}`];
      expect(bg, `--sy-note-${key}`).toBeDefined();
      expect(contrast(c["note-fg"]!, bg!), `note-fg on ${key}`).toBeGreaterThanOrEqual(4.5);
      expect(tokens).toContain(`--color-note-${key}: var(--sy-note-${key});`);
    }
  });

  it("board and note sizes match the shared protocol", () => {
    expect(tokens).toContain(`--sy-board-width: ${BOARD_WIDTH}px;`);
    expect(tokens).toContain(`--sy-board-height: ${BOARD_HEIGHT}px;`);
    expect(tokens).toContain(`--sy-note-size: ${NOTE_SIZE}px;`);
  });

  it("no colours outside tokens.css", () => {
    for (const path of files(SRC).filter((p) => /\.(tsx?|css)$/.test(p) && !p.endsWith("tokens.css"))) {
      const text = readFileSync(path, "utf8");
      expect(text.match(/#[0-9a-fA-F]{3,8}\b(?![\w-])/g) ?? [], path).toEqual([]);
      expect(text.match(/\b(rgb|hsl|oklch)a?\(/g) ?? [], path).toEqual([]);
    }
  });

  it("no hard-coded sizes in class names (only token-backed values)", () => {
    for (const path of files(SRC).filter((p) => p.endsWith(".tsx"))) {
      const text = readFileSync(path, "utf8");
      expect(text.match(/\b[\w:-]+-\[[^\]]*\d(px|rem|em)[^\]]*\]/g) ?? [], path).toEqual([]);
    }
  });
});
