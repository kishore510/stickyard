import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { BOARD_HEIGHT, BOARD_WIDTH, NOTE_MAX_W, SHAPE_MAX_H, SHAPE_MAX_W, SHAPE_MIN_H, SHAPE_MIN_W } from "@stickyard/shared";
import { grid, GRID_GAP } from "../src/canvas/arrange";
import { FIT_MAX_ZOOM, MAX_ZOOM, MIN_ZOOM, PAN_MARGIN, fitViewport, newNotePosition, panExtent } from "../src/canvas/geometry";
import { BOARD_NODE } from "../src/canvas/nodes";
import { onBoardPoint } from "../src/cursors/cursors";
import { NOTE_LIMITS, sizeAt } from "../src/notes/size";
import { TEMPLATES } from "../src/templates/registry";
import { clampTemplateOrigin, templateBounds, templateOrigin } from "../src/templates/place";

/*
 * Board size, protocol v16 (web): every size-dependent rule reads BOARD_WIDTH / BOARD_HEIGHT, so
 * the 6400 x 4000 board needs no other change. Zoom limits stay as they were: the goal is room
 * to work, not fitting the whole board on screen.
 */

const SHAPE_LIMITS = { minW: SHAPE_MIN_W, minH: SHAPE_MIN_H, maxW: SHAPE_MAX_W, maxH: SHAPE_MAX_H };

describe("the bigger board on the web", () => {
  it("zoom limits are unchanged", () => {
    expect([MIN_ZOOM, MAX_ZOOM, FIT_MAX_ZOOM]).toEqual([0.1, 2, 1]);
  });

  it("the tokens mirror the board size", () => {
    const tokens = readFileSync(resolve(import.meta.dirname, "../src/styles/tokens.css"), "utf8");
    expect(tokens).toContain(`--sy-board-width: ${BOARD_WIDTH}px;`);
    expect(tokens).toContain(`--sy-board-height: ${BOARD_HEIGHT}px;`);
  });

  it("the pan extent is the board plus the margin; the board node (edge, minimap, drag limit) is the whole board", () => {
    expect(panExtent()).toEqual([
      [-PAN_MARGIN, -PAN_MARGIN],
      [BOARD_WIDTH + PAN_MARGIN, BOARD_HEIGHT + PAN_MARGIN],
    ]);
    expect(BOARD_NODE).toMatchObject({ position: { x: 0, y: 0 }, width: BOARD_WIDTH, height: BOARD_HEIGHT, measured: { width: BOARD_WIDTH, height: BOARD_HEIGHT } });
  });

  it("resizing stops at the new far edge", () => {
    const note = { x: BOARD_WIDTH - 200, y: BOARD_HEIGHT - 100, w: 160, h: 96 };
    expect(sizeAt(note, NOTE_MAX_W, NOTE_MAX_W)).toMatchObject({ w: 200, h: 100 });
    const shape = { x: BOARD_WIDTH - 1000, y: 0, w: 200, h: 120 };
    expect(sizeAt(shape, SHAPE_MAX_W, 120, SHAPE_LIMITS).w).toBe(1000);
    expect(sizeAt({ x: 3200, y: 2000, w: 160, h: 160 }, NOTE_MAX_W, NOTE_MAX_W, NOTE_LIMITS)).toMatchObject({ w: NOTE_MAX_W, h: NOTE_MAX_W });
  });

  it("templates go where the person is looking, and stay whole at the new far corner", () => {
    const t = TEMPLATES[0]!;
    const { width, height } = templateBounds(t);
    const centre = { x: 5000, y: 3000 };
    expect(templateOrigin(t, centre)).toEqual({ x: Math.round(5000 - width / 2), y: Math.round(3000 - height / 2) });
    expect(clampTemplateOrigin(t, { x: BOARD_WIDTH, y: BOARD_HEIGHT })).toEqual({ x: BOARD_WIDTH - width, y: BOARD_HEIGHT - height });
  });

  it("a new note goes in the middle of the view, not the middle of the board", () => {
    expect(newNotePosition({ x: 5600, y: 3500 }, [])).toEqual({ x: 5600 - 80, y: 3500 - 80 });
    expect(newNotePosition({ x: BOARD_WIDTH + 500, y: BOARD_HEIGHT + 500 }, [])).toEqual({ x: BOARD_WIDTH - 160, y: BOARD_HEIGHT - 160 });
  });

  it("an empty board's first view is the board's middle at 100%", () => {
    for (const size of [{ width: 360, height: 600 }, { width: 400, height: 700 }, { width: 900, height: 700 }]) {
      const v = fitViewport([], size, 24);
      expect(v.zoom).toBe(1);
      expect({ x: (size.width / 2 - v.x) / v.zoom, y: (size.height / 2 - v.y) / v.zoom }).toEqual({ x: BOARD_WIDTH / 2, y: BOARD_HEIGHT / 2 });
    }
  });

  it("cursors count anywhere on the new board as on it", () => {
    expect(onBoardPoint(BOARD_WIDTH, BOARD_HEIGHT)).toBe(true);
    expect(onBoardPoint(BOARD_WIDTH + 1, 0)).toBe(false);
  });

  it("Grid says too wide only past the new width, and shifts back onto the board", () => {
    const row = (n: number, w: number) => Array.from({ length: n }, (_, i) => ({ id: `n${i}`, x: i * 10, y: 0, w, h: 96 }));
    // 13 notes of 480 with 12 gaps: 6,528 > 6,400; 12 fit (6,024).
    expect(grid(row(13, NOTE_MAX_W), 13, GRID_GAP).reason).toBe("wide");
    expect(grid(row(12, NOTE_MAX_W), 12, GRID_GAP).reason).toBeNull();
    // Starting near the right edge: the grid moves left so its far side is on the board.
    const nearEdge = row(12, NOTE_MAX_W).map((r) => ({ ...r, x: BOARD_WIDTH - 500 }));
    const changes = grid(nearEdge, 12, GRID_GAP).changes;
    const right = Math.max(...[...changes.values()].map((c) => c.x + NOTE_MAX_W));
    expect(right).toBeLessThanOrEqual(BOARD_WIDTH);
  });
});
