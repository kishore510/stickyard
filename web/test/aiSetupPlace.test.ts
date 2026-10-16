import { describe, expect, it } from "vitest";
import { BOARD_HEIGHT, BOARD_WIDTH } from "@stickyard/shared";
import { SETUP_PLACE_MARGIN, findSetupPlace } from "../src/ai/setupPlace";

/*
 * Board setup from a prompt (10b, v0.43.0): where the result goes. The nearest free rectangle to the
 * view centre that fits all of it without overlapping anything on the board; if none, below the
 * lowest item; always clamped onto the board.
 */

type Rect = { x: number; y: number; w: number; h: number };
const size = { width: 1200, height: 800 };
const hits = (at: { x: number; y: number }, items: Rect[]) =>
  items.some((r) => at.x < r.x + r.w + SETUP_PLACE_MARGIN && r.x - SETUP_PLACE_MARGIN < at.x + size.width && at.y < r.y + r.h + SETUP_PLACE_MARGIN && r.y - SETUP_PLACE_MARGIN < at.y + size.height);

describe("placing the result", () => {
  it("an empty board: centred on the view", () => {
    expect(findSetupPlace(size, [], { x: 3200, y: 2000 })).toEqual({ x: 2600, y: 1600 });
  });

  it("centred on the view, clamped onto the board near an edge", () => {
    expect(findSetupPlace(size, [], { x: 100, y: 50 })).toEqual({ x: 0, y: 0 });
    expect(findSetupPlace(size, [], { x: BOARD_WIDTH, y: BOARD_HEIGHT })).toEqual({ x: BOARD_WIDTH - size.width, y: BOARD_HEIGHT - size.height });
  });

  it("existing items under the view: the nearest free spot, not overlapping any of them", () => {
    const items = [
      { x: 2800, y: 1800, w: 640, h: 400 },
      { x: 3500, y: 1900, w: 160, h: 160 },
    ];
    const at = findSetupPlace(size, items, { x: 3200, y: 2000 });
    expect(hits(at, items)).toBe(false);
    // Nearer than the far corners of the board.
    const d = Math.hypot(at.x + size.width / 2 - 3200, at.y + size.height / 2 - 2000);
    expect(d).toBeLessThan(1400);
    expect(findSetupPlace(size, items, { x: 3200, y: 2000 })).toEqual(at);
  });

  it("a crowded board with one free area: found", () => {
    // Everything covered except the bottom-right corner.
    const items: Rect[] = [];
    for (let x = 0; x < BOARD_WIDTH; x += 400) for (let y = 0; y < BOARD_HEIGHT; y += 400) if (!(x >= 4800 && y >= 2800)) items.push({ x, y, w: 380, h: 380 });
    const at = findSetupPlace(size, items, { x: 1000, y: 1000 });
    expect(hits(at, items)).toBe(false);
    expect(at.x).toBeGreaterThanOrEqual(4800);
    expect(at.y).toBeGreaterThanOrEqual(2800);
  });

  it("a full board: below the lowest item, clamped onto the board", () => {
    const items: Rect[] = [];
    for (let x = 0; x < BOARD_WIDTH; x += 400) for (let y = 0; y < 2400; y += 400) items.push({ x, y, w: 380, h: 380 });
    const at = findSetupPlace(size, [...items, { x: 0, y: 2400, w: BOARD_WIDTH, h: 1300 }], { x: 3200, y: 1000 });
    // Lowest item ends at 3700: below it doesn't fit, so clamped to the bottom edge.
    expect(at).toEqual({ x: 2600, y: BOARD_HEIGHT - size.height });
    // A short result fits in the strip under the lowest item: found there, not overlapping.
    const strip = findSetupPlace({ width: 1200, height: 200 }, [...items, { x: 0, y: 2400, w: BOARD_WIDTH, h: 1300 }], { x: 3200, y: 1000 });
    expect(strip.y).toBeGreaterThanOrEqual(3700 + SETUP_PLACE_MARGIN);
    expect(strip.y + 200).toBeLessThanOrEqual(BOARD_HEIGHT);
  });

  it("a result bigger than the board is put at the top-left", () => {
    expect(findSetupPlace({ width: BOARD_WIDTH + 10, height: 100 }, [], { x: 3200, y: 2000 })).toEqual({ x: 0, y: 1950 });
  });
});
