// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { StickyardMark } from "../src/brand/StickyardMark";

/* The welcome screen's mark (web only): decorative inline SVG, colours from tokens, unique ids per instance. */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

function render(node: React.ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(node));
  return host;
}

const SRC = new URL("../src/", import.meta.url).pathname;

describe("StickyardMark", () => {
  it("is decorative: the whole SVG is aria-hidden and has no accessible text", () => {
    const host = render(<StickyardMark />);
    const svg = host.querySelector("svg");
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(svg?.getAttribute("focusable")).toBe("false");
    expect(host.querySelector("title")).toBeNull();
  });

  it("has four notes and three cursors labelled with generic names, and none of the source's extras", () => {
    const host = render(<StickyardMark />);
    expect(host.querySelectorAll("[data-mark-note]")).toHaveLength(4);
    expect([...host.querySelectorAll("[data-mark-cursor]")].map((c) => c.textContent)).toEqual(["Alex", "Sam", "Priya"]);
    const text = host.textContent ?? "";
    for (const gone of ["LOCAL-FIRST", "stickyard", "REAL-TIME", "Krishna", "Sarah"]) expect(text).not.toContain(gone);
    expect(host.querySelector("pattern")).toBeNull();
    expect(host.querySelector("circle[r='180'], circle[r='140']")).toBeNull();
  });

  it("two marks on one page use different gradient and filter ids, and every reference points inside its own mark", () => {
    const host = render(
      <>
        <StickyardMark />
        <StickyardMark />
      </>,
    );
    const [a, b] = [...host.querySelectorAll("svg")];
    const ids = (svg: Element | undefined) => [...(svg?.querySelectorAll("[id]") ?? [])].map((el) => el.id);
    expect(ids(a).length).toBeGreaterThanOrEqual(5);
    expect(ids(a).filter((id) => ids(b).includes(id))).toEqual([]);
    for (const svg of [a, b]) {
      const own = new Set(ids(svg));
      const refs = [...(svg?.outerHTML.matchAll(/url\(#([^)]+)\)/g) ?? [])].map((m) => m[1]);
      expect(refs.length).toBeGreaterThan(0);
      for (const ref of refs) expect(own.has(ref ?? ""), ref).toBe(true);
    }
  });

  it("uses no colour values: only var(--sy-brand-...) tokens", () => {
    const host = render(<StickyardMark />);
    const html = host.innerHTML;
    expect(html.match(/#[0-9a-fA-F]{3,8}\b(?![\w-])/g) ?? []).toEqual([]);
    expect(html.match(/\b(rgb|hsl|oklch)a?\(/g) ?? []).toEqual([]);
    expect(html).toContain("var(--sy-brand-");
    const tokens = readFileSync(`${SRC}styles/tokens.css`, "utf8");
    for (const name of new Set([...html.matchAll(/var\((--sy-brand-[\w-]+)\)/g)].map((m) => m[1]))) {
      expect(tokens, name).toMatch(new RegExp(`${name}:\\s*#[0-9a-f]{6,8};`));
    }
  });

  it("scales with its container (max-width 100%, no fixed pixel size)", () => {
    const host = render(<StickyardMark className="w-brand-mark" />);
    const svg = host.querySelector("svg");
    expect(svg?.getAttribute("width")).toBeNull();
    expect(svg?.getAttribute("class")).toContain("max-w-full");
    expect(svg?.getAttribute("viewBox")).toMatch(/^[\d.]+ [\d.]+ [\d.]+ [\d.]+$/);
  });

  it("the cursors drift slowly in CSS only, and not at all under reduced motion", () => {
    const host = render(<StickyardMark />);
    expect(host.querySelectorAll(".sy-mark-drift")).toHaveLength(3);
    const css = readFileSync(`${SRC}index.css`, "utf8");
    expect(css).toMatch(/\.sy-mark-drift\s*\{[^}]*animation:/);
    const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced).toMatch(/\.sy-mark-drift\s*\{[^}]*animation:\s*none/);
  });
});
