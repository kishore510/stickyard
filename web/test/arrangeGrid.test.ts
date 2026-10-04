import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BOARD_HEIGHT, BOARD_WIDTH, MAX_NOTES_PER_ROOM, NOTE_MAX_H, NOTE_MAX_W, NOTE_MIN_H, NOTE_MIN_W } from "@stickyard/shared";
import { GRID_GAP, applyRects, autoColumns, grid, readingOrder, type Placed } from "../src/canvas/arrange";
import { GRID_HINTS, gridDisabledReason } from "../src/canvas/SelectionBar";

/* Slice arrange-grid: lay out a selection in a grid. Pure; every result stays on the board. */

const r = (id: string, x: number, y: number, w = 160, h = 160): Placed => ({ id, x, y, w, h });
const onBoard = (p: Placed) =>
  p.x >= 0 && p.y >= 0 && p.x + p.w <= BOARD_WIDTH && p.y + p.h <= BOARD_HEIGHT && Number.isInteger(p.x) && Number.isInteger(p.y);
const overlaps = (a: Placed, b: Placed) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const byId = (rects: Placed[]) => Object.fromEntries(rects.map((p) => [p.id, [p.x, p.y]]));

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
function randomRects(seed: number, n: number, maxW = NOTE_MAX_W, maxH = NOTE_MAX_H): Placed[] {
  const next = rng(seed);
  return Array.from({ length: n }, (_, i) => {
    const w = NOTE_MIN_W + Math.floor(next() * (maxW - NOTE_MIN_W));
    const h = NOTE_MIN_H + Math.floor(next() * (maxH - NOTE_MIN_H));
    return r(`n${i}`, Math.floor(next() * (BOARD_WIDTH - w)), Math.floor(next() * (BOARD_HEIGHT - h)), w, h);
  });
}

describe("readingOrder", () => {
  it("groups notes into row bands by vertical overlap, then orders each band by x", () => {
    const rects = [r("c", 50, 400), r("b", 500, 120), r("a", 100, 100), r("d", 600, 420)];
    expect(readingOrder(rects).map((p) => p.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("notes that only touch vertically are in different bands", () => {
    expect(readingOrder([r("b", 0, 160), r("a", 500, 0)]).map((p) => p.id)).toEqual(["a", "b"]);
  });

  it("ties (the same place) are ordered by id, so the order is stable", () => {
    expect(readingOrder([r("b", 10, 10), r("a", 10, 10)]).map((p) => p.id)).toEqual(["a", "b"]);
  });
});

describe("grid", () => {
  it("lays notes out in reading order, each column as wide as its widest note and each row as tall as its tallest", () => {
    const rects = [r("a", 100, 100, 200, 100), r("b", 600, 110, 160, 300), r("c", 120, 700, 120, 120), r("d", 700, 650, 96, 200)];
    const out = applyRects(rects, grid(rects, 2, 24).changes);
    // Columns: 200 and 160 wide; rows: 300 and 200 tall. Anchored at the selection's top-left (100, 100).
    expect(byId(out)).toEqual({ a: [100, 100], b: [324, 100], c: [100, 424], d: [324, 424] });
  });

  it("anchors at the selection's top-left and top-left aligns notes in their cells", () => {
    const rects = [r("a", 300, 50, 96, 96), r("b", 40, 200, 300, 120), r("c", 900, 500, 160, 200)];
    const out = applyRects(rects, grid(rects, 3, 10).changes);
    // Reading order: a (band 50..146), then b (200..320, x 40) and c (500..700) in their own bands.
    expect(byId(out)).toEqual({ a: [40, 50], b: [146, 50], c: [456, 50] });
  });

  it("two notes", () => {
    const rects = [r("a", 0, 0), r("b", 1000, 900)];
    expect(byId(applyRects(rects, grid(rects, 2, GRID_GAP).changes))).toEqual({ a: [0, 0], b: [160 + GRID_GAP, 0] });
    expect(byId(applyRects(rects, grid(rects, 1, GRID_GAP).changes))).toEqual({ a: [0, 0], b: [0, 160 + GRID_GAP] });
  });

  it("columns are kept within 1 and the note count", () => {
    const rects = [r("a", 0, 0), r("b", 1000, 900)];
    expect(grid(rects, 9, GRID_GAP)).toEqual(grid(rects, 2, GRID_GAP));
    expect(grid(rects, 0, GRID_GAP)).toEqual(grid(rects, 1, GRID_GAP));
  });

  it("separates notes that already overlap", () => {
    const rects = [r("a", 500, 500), r("b", 500, 500), r("c", 520, 510)];
    const out = applyRects(rects, grid(rects, 3, GRID_GAP).changes);
    for (const p of out) for (const q of out) if (p !== q) expect(overlaps(p, q)).toBe(false);
  });

  it("returns only the notes it moves, and never resizes", () => {
    const rects = [r("a", 0, 0), r("b", 184, 0), r("c", 0, 500)];
    const { changes } = grid(rects, 2, 24);
    expect([...changes.keys()]).toEqual(["c"]);
    expect(changes.get("c")).toEqual({ x: 0, y: 184, w: 160, h: 160 });
  });

  it("is idempotent, with mixed sizes and any column count", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const rects = randomRects(seed, 2 + (seed % 12), 200, 200);
      const columns = Math.max(1 + (seed % 5), Math.ceil(rects.length / 6));
      const first = grid(rects, columns, GRID_GAP);
      expect(first.reason).toBeNull();
      const once = applyRects(rects, first.changes);
      expect(grid(once, columns, GRID_GAP)).toEqual({ changes: new Map(), reason: null });
    }
  });

  it("is clamped to the board: a grid that would run off the edge is shifted back on", () => {
    const rects = [r("a", BOARD_WIDTH - 200, BOARD_HEIGHT - 170), r("b", BOARD_WIDTH - 160, BOARD_HEIGHT - 160)];
    const out = applyRects(rects, grid(rects, 2, 24).changes);
    expect(out.every(onBoard)).toBe(true);
    expect(byId(out)).toEqual({ a: [BOARD_WIDTH - 344, BOARD_HEIGHT - 170], b: [BOARD_WIDTH - 160, BOARD_HEIGHT - 170] });
  });

  it("200 notes of mixed sizes: on the board, no overlaps, idempotent", () => {
    const rects = randomRects(7, MAX_NOTES_PER_ROOM, 150, 130);
    const columns = autoColumns(rects);
    const result = grid(rects, columns, GRID_GAP);
    expect(result.reason).toBeNull();
    const out = applyRects(rects, result.changes);
    expect(out.every(onBoard)).toBe(true);
    for (let i = 0; i < out.length; i++) for (let j = i + 1; j < out.length; j++) expect(overlaps(out[i]!, out[j]!)).toBe(false);
    expect(grid(out, columns, GRID_GAP).changes.size).toBe(0);
  });

  it("doesn't fit the board: returns nothing and a reason", () => {
    const big = Array.from({ length: 10 }, (_, i) => r(`n${i}`, i * 10, 0, NOTE_MAX_W, NOTE_MAX_H));
    const wide = grid(big, 10, GRID_GAP);
    expect(wide.changes.size).toBe(0);
    expect(wide.reason).toBe("wide");
    const tall = grid(big, 1, GRID_GAP);
    expect(tall.changes.size).toBe(0);
    expect(tall.reason).toBe("tall");
    const many = Array.from({ length: 60 }, (_, i) => r(`n${i}`, 0, 0, NOTE_MAX_W, NOTE_MAX_H));
    expect(grid(many, 8, GRID_GAP)).toEqual({ changes: new Map(), reason: "big" });
  });

  it("fewer than 2 notes: nothing", () => {
    expect(grid([r("a", 0, 0)], 1, GRID_GAP)).toEqual({ changes: new Map(), reason: null });
  });
});

describe("autoColumns", () => {
  it("one row of notes stays one row; one column stays one column", () => {
    const row = [0, 1, 2, 3, 4].map((i) => r(`n${i}`, i * 200, 0));
    expect(autoColumns(row)).toBe(5);
    const column = [0, 1, 2, 3, 4].map((i) => r(`n${i}`, 0, i * 200));
    expect(autoColumns(column)).toBe(1);
  });

  it("a square spread of square notes gives about the square root of the count", () => {
    const pile = Array.from({ length: 9 }, (_, i) => r(`n${i}`, 0, 0));
    expect(autoColumns(pile)).toBe(3);
    const scattered = Array.from({ length: 16 }, (_, i) => r(`n${i}`, (i % 4) * 300, Math.floor(i / 4) * 300));
    expect(autoColumns(scattered)).toBe(4);
  });

  it("wide notes get fewer columns than square ones in the same spread", () => {
    const square = Array.from({ length: 12 }, (_, i) => r(`n${i}`, (i % 4) * 500, Math.floor(i / 4) * 300, 160, 160));
    const wide = square.map((p) => ({ ...p, w: 480, h: 120 }));
    expect(autoColumns(wide)).toBeLessThan(autoColumns(square));
  });

  it("is always between 1 and the count, and stable after a grid", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const rects = randomRects(seed, 2 + (seed % 15), 240, 240);
      const columns = autoColumns(rects);
      expect(columns).toBeGreaterThanOrEqual(1);
      expect(columns).toBeLessThanOrEqual(rects.length);
    }
    const nine = Array.from({ length: 9 }, (_, i) => r(`n${i}`, i * 37, i * 11));
    const laid = applyRects(nine, grid(nine, autoColumns(nine), GRID_GAP).changes);
    expect(autoColumns(laid)).toBe(autoColumns(nine));
  });
});

describe("gridDisabledReason", () => {
  const ok = { count: 3, live: true, held: false, unsaved: false };
  it("is null when the grid can run", () => expect(gridDisabledReason(ok)).toBeNull());
  it.each([
    [{ ...ok, count: 1 }, GRID_HINTS.few],
    [{ ...ok, live: false }, GRID_HINTS.offline],
    [{ ...ok, held: true }, GRID_HINTS.held],
    [{ ...ok, unsaved: true }, GRID_HINTS.unsaved],
  ])("%o: %s", (state, reason) => expect(gridDisabledReason(state)).toBe(reason));
});

describe("grid gap token", () => {
  it("tokens.css mirrors GRID_GAP", () => {
    const tokens = readFileSync(new URL("../src/styles/tokens.css", import.meta.url), "utf8");
    expect(tokens).toContain(`--sy-grid-gap: ${GRID_GAP}px;`);
  });
});
