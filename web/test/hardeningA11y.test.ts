import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/*
 * Hardening (v0.39.1), from the accessibility pass (npm run a11y: axe-core at 360, 768 and 1280 px,
 * light and dark): small defects it found, kept fixed.
 */

const SRC = new URL("../src/", import.meta.url).pathname;
const tokens = readFileSync(join(SRC, "styles/tokens.css"), "utf8");
const css = readFileSync(join(SRC, "index.css"), "utf8");
const topBar = readFileSync(join(SRC, "shell/TopBar.tsx"), "utf8");

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
const block = (selector: string) => {
  const start = css.indexOf(`${selector} {`);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf("}", start));
};

describe("accessibility pass (v0.39.1)", () => {
  it.each([':root,\n[data-theme="light"]', '[data-theme="dark"]'])("muted text on the canvas and the board is 4.5:1 or more in %s", (selector) => {
    // The React Flow attribution (and any muted hint) sits on the canvas around the board: axe found 4.43:1 in light.
    const c = theme(selector);
    for (const bg of ["canvas", "board"]) expect(contrast(c["fg-muted"]!, c[bg]!), `fg-muted on ${bg}`).toBeGreaterThanOrEqual(4.5);
  });

  it("the canvas attribution link is a full touch target", () => {
    expect(block(".react-flow__attribution a")).toMatch(/min-height:\s*var\(--sy-touch-min\)/);
  });

  it("the top bar's start-page link is at least a touch target wide", () => {
    const link = /<a[^>]*aria-label="Stickyard, start page"[^>]*>/.exec(topBar)?.[0] ?? "";
    expect(link).toContain("min-w-touch");
  });
});
