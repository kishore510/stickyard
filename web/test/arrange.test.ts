import { describe, expect, it } from "vitest";
import { BOARD_HEIGHT, BOARD_WIDTH, NOTE_MAX_H, NOTE_MAX_W, NOTE_MIN_H, NOTE_MIN_W } from "@stickyard/shared";
import { ALIGN_MODES, align, applyRects, distribute, groupOffset, matchSize, type Placed } from "../src/canvas/arrange";

/* Slice 2.8: align, distribute, match size and the group drag clamp. Pure; every result stays on the board. */

const r = (id: string, x: number, y: number, w = 160, h = 160): Placed => ({ id, x, y, w, h });
const onBoard = (p: Placed) =>
  p.x >= 0 && p.y >= 0 && p.x + p.w <= BOARD_WIDTH && p.y + p.h <= BOARD_HEIGHT && Number.isInteger(p.x) && Number.isInteger(p.y);
const sizeOk = (p: Placed) => p.w >= NOTE_MIN_W && p.w <= NOTE_MAX_W && p.h >= NOTE_MIN_H && p.h <= NOTE_MAX_H;

/** A small seeded generator, so property runs are repeatable. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
function randomRects(seed: number, n: number): Placed[] {
  const next = rng(seed);
  return Array.from({ length: n }, (_, i) => {
    const w = NOTE_MIN_W + Math.floor(next() * (NOTE_MAX_W - NOTE_MIN_W));
    const h = NOTE_MIN_H + Math.floor(next() * (NOTE_MAX_H - NOTE_MIN_H));
    return r(`n${i}`, Math.floor(next() * (BOARD_WIDTH - w)), Math.floor(next() * (BOARD_HEIGHT - h)), w, h);
  });
}

describe("align", () => {
  const rects = [r("a", 100, 100, 160, 160), r("b", 400, 300, 200, 100), r("c", 250, 50, 96, 120)];

  it.each([
    ["left", { a: [100, 100], b: [100, 300], c: [100, 50] }],
    ["right", { a: [440, 100], b: [400, 300], c: [504, 50] }],
    ["centre", { a: [270, 100], b: [250, 300], c: [302, 50] }],
    ["top", { a: [100, 50], b: [400, 50], c: [250, 50] }],
    ["bottom", { a: [100, 240], b: [400, 300], c: [250, 280] }],
    ["middle", { a: [100, 145], b: [400, 175], c: [250, 165] }],
  ] as const)("%s lines the notes up on that edge or centre line of their bounds", (mode, expected) => {
    const out = applyRects(rects, align(rects, mode));
    expect(Object.fromEntries(out.map((p) => [p.id, [p.x, p.y]]))).toEqual(expected);
  });

  it("returns only the notes that change, and nothing for fewer than two", () => {
    const changes = align([r("a", 100, 100), r("b", 100, 300)], "left");
    expect(changes.size).toBe(0);
    expect(align([r("a", 1, 1)], "left").size).toBe(0);
  });

  it("property: results are on the board, sizes unchanged, and aligning again changes nothing", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const rects = randomRects(seed, 2 + (seed % 9));
      for (const mode of ALIGN_MODES) {
        const once = applyRects(rects, align(rects, mode));
        expect(once.every(onBoard), `${mode} seed ${seed}`).toBe(true);
        expect(once.map((p) => [p.w, p.h])).toEqual(rects.map((p) => [p.w, p.h]));
        expect(align(once, mode).size, `${mode} idempotent seed ${seed}`).toBe(0);
      }
    }
  });
});

describe("distribute", () => {
  it("needs three or more notes", () => {
    expect(distribute([r("a", 0, 0), r("b", 500, 0)], "horizontal").size).toBe(0);
  });

  it("horizontal: equal gaps between notes, ordered by centre; the outermost two stay put", () => {
    const rects = [r("a", 0, 0, 100), r("c", 900, 10, 100), r("b", 200, 20, 200)];
    const out = Object.fromEntries(applyRects(rects, distribute(rects, "horizontal")).map((p) => [p.id, p]));
    // Span 0..1000, widths 400: gaps of 300.
    expect([out.a?.x, out.b?.x, out.c?.x]).toEqual([0, 400, 900]);
    expect([out.a?.y, out.b?.y, out.c?.y]).toEqual([0, 20, 10]);
  });

  it("vertical works the same way down the board", () => {
    const rects = [r("a", 0, 0, 160, 100), r("b", 10, 150, 160, 100), r("c", 20, 600, 160, 100)];
    const out = Object.fromEntries(applyRects(rects, distribute(rects, "vertical")).map((p) => [p.id, p.y]));
    expect(out).toEqual({ a: 0, b: 300, c: 600 });
  });

  it("property: on the board, and distributing again changes nothing", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const rects = randomRects(seed, 3 + (seed % 8));
      for (const axis of ["horizontal", "vertical"] as const) {
        const once = applyRects(rects, distribute(rects, axis));
        expect(once.every(onBoard)).toBe(true);
        const twice = applyRects(once, distribute(once, axis));
        // Rounding may settle by one unit on the first pass, never after.
        for (const [i, p] of twice.entries()) {
          expect(Math.abs(p.x - once[i]!.x) + Math.abs(p.y - once[i]!.y), `${axis} seed ${seed}`).toBeLessThanOrEqual(1);
        }
        expect(distribute(twice, axis).size).toBeLessThanOrEqual(distribute(once, axis).size);
      }
    }
  });
});

describe("match size", () => {
  const rects = [r("ref", 100, 100, 300, 200), r("b", 500, 500, 160, 160), r("c", BOARD_WIDTH - 160, 0, 160, 96)];

  it("uses the first selected note as the reference", () => {
    const out = Object.fromEntries(applyRects(rects, matchSize(rects, "both")).map((p) => [p.id, [p.w, p.h]]));
    expect(out).toEqual({ ref: [300, 200], b: [300, 200], c: [300, 200] });
    const width = Object.fromEntries(applyRects(rects, matchSize(rects, "width")).map((p) => [p.id, [p.w, p.h]]));
    expect(width).toEqual({ ref: [300, 200], b: [300, 160], c: [300, 96] });
    const height = Object.fromEntries(applyRects(rects, matchSize(rects, "height")).map((p) => [p.id, [p.w, p.h]]));
    expect(height).toEqual({ ref: [300, 200], b: [160, 200], c: [160, 200] });
  });

  it("a note at the right edge moves left so its new width still fits on the board", () => {
    const out = applyRects(rects, matchSize(rects, "width")).find((p) => p.id === "c");
    expect(out).toMatchObject({ x: BOARD_WIDTH - 300, w: 300 });
  });

  it("property: sizes within min/max, on the board, idempotent", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const rects = randomRects(seed, 2 + (seed % 9));
      for (const mode of ["width", "height", "both"] as const) {
        const once = applyRects(rects, matchSize(rects, mode));
        expect(once.every((p) => onBoard(p) && sizeOk(p))).toBe(true);
        expect(matchSize(once, mode).size).toBe(0);
      }
    }
  });
});

describe("group drag clamp (shared offset)", () => {
  const group = [r("a", 100, 100), r("b", 400, 300)];

  it("passes an offset that keeps everyone on the board", () => {
    expect(groupOffset(group, 50, -20)).toEqual({ dx: 50, dy: -20 });
  });

  it("clamps the shared offset at the board's edges, so the arrangement is kept", () => {
    expect(groupOffset(group, -500, -500)).toEqual({ dx: -100, dy: -100 });
    const right = BOARD_WIDTH - (400 + 160);
    const bottom = BOARD_HEIGHT - (300 + 160);
    expect(groupOffset(group, 99999, 99999)).toEqual({ dx: right, dy: bottom });
  });

  it("property: every note stays on the board and keeps its distance to the others", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const rects = randomRects(seed, 2 + (seed % 9));
      const next = rng(seed * 7);
      const { dx, dy } = groupOffset(rects, (next() - 0.5) * 8000, (next() - 0.5) * 5000);
      const moved = rects.map((p) => ({ ...p, x: p.x + dx, y: p.y + dy }));
      expect(moved.every(onBoard)).toBe(true);
      expect(moved[0]!.x - moved[1]!.x).toBe(rects[0]!.x - rects[1]!.x);
    }
  });
});
