import { describe, expect, it } from "vitest";
import { BOARD_HEIGHT, BOARD_WIDTH } from "@stickyard/shared";
import { FIT_MAX_ZOOM, fitViewport, viewportCentre } from "../src/canvas/geometry";
import {
  CLUSTER_GAP,
  FIT_READABLE_ZOOM,
  JUMP_MIN_ZOOM,
  VIEW_ANIMATION_MS,
  ZOOM_SELECTION_HINT,
  clusters,
  fitPlan,
  inViewport,
  itemGap,
  jumpViewport,
  largestCluster,
  selectionViewport,
  viewDuration,
  zoomSelectionReason,
} from "../src/canvas/navigation";

/* Navigation (v0.24.0): Fit with an outlier, zoom to selection, jump to a pointer, animation. */

const SIZE = { width: 800, height: 600 };
const PAD = 72;
const item = (id: string, x: number, y: number, w = 200, h = 200) => ({ id, x, y, w, h });

/** A tidy group of `n` notes in a row starting at (x, y). */
const row = (prefix: string, n: number, x: number, y: number) => Array.from({ length: n }, (_, i) => item(`${prefix}${i}`, x + i * 240, y));

describe("constants", () => {
  it("readable zoom, cluster gap and jump zoom are as specified", () => {
    expect(FIT_READABLE_ZOOM).toBe(0.25);
    expect(CLUSTER_GAP).toBe(600);
    expect(JUMP_MIN_ZOOM).toBe(0.5);
  });
});

describe("fitPlan", () => {
  it("everything within the readable zoom: exactly today's fit", () => {
    const items = row("n", 4, 1000, 1000);
    const plan = fitPlan(items, SIZE, PAD);
    expect(plan).toEqual({ viewport: fitViewport(items, SIZE, PAD), partial: false, outside: 0 });
    expect(plan.viewport.zoom).toBeGreaterThanOrEqual(FIT_READABLE_ZOOM);
  });

  it("one far outlier: the cluster is fitted and the outlier reported out of view", () => {
    const cluster = row("n", 5, 2800, 1800);
    const outlier = item("far", BOARD_WIDTH - 200, BOARD_HEIGHT - 200);
    const items = [...cluster, outlier];
    expect(fitViewport(items, SIZE, PAD).zoom).toBeLessThan(FIT_READABLE_ZOOM);
    const plan = fitPlan(items, SIZE, PAD);
    expect(plan.partial).toBe(true);
    expect(plan.outside).toBe(1);
    expect(plan.viewport).toEqual(fitViewport(cluster, SIZE, PAD));
    expect(cluster.every((n) => inViewport(n, plan.viewport, SIZE))).toBe(true);
    expect(inViewport(outlier, plan.viewport, SIZE)).toBe(false);
  });

  it("two equal clusters: the one nearer the board's centre wins, whatever the input order", () => {
    const near = row("near", 3, BOARD_WIDTH / 2 - 300, BOARD_HEIGHT / 2);
    const far = row("far", 3, 0, 0);
    expect(largestCluster([...far, ...near])).toEqual(near);
    expect(largestCluster([...near, ...far])).toEqual(near);
    expect(fitPlan([...far, ...near], SIZE, PAD).viewport).toEqual(fitViewport(near, SIZE, PAD));
  });

  it("equal clusters equally far from the centre: the higher, then the further left", () => {
    const cx = BOARD_WIDTH / 2;
    const cy = BOARD_HEIGHT / 2;
    const top = [item("t", cx - 100, cy - 1600)];
    const bottom = [item("b", cx - 100, cy + 1400)];
    expect(largestCluster([...bottom, ...top])).toEqual(top);
    const left = [item("l", cx - 2100, cy - 100)];
    const right = [item("r", cx + 1900, cy - 100)];
    expect(largestCluster([...right, ...left])).toEqual(left);
  });

  it("the cluster with the most items wins over one nearer the centre", () => {
    const big = row("big", 4, 0, 0);
    const small = [item("mid", BOARD_WIDTH / 2, BOARD_HEIGHT / 2)];
    expect(largestCluster([...small, ...big])).toEqual(big);
  });

  it("a single item: a plain fit", () => {
    const one = [item("a", 4000, 3000)];
    expect(fitPlan(one, SIZE, PAD)).toEqual({ viewport: fitViewport(one, SIZE, PAD), partial: false, outside: 0 });
  });

  it("an empty board: unchanged (its middle at 100%)", () => {
    const plan = fitPlan([], SIZE, PAD);
    expect(plan).toEqual({ viewport: fitViewport([], SIZE, PAD), partial: false, outside: 0 });
    expect(plan.viewport.zoom).toBe(1);
  });

  it("everything spread out but linked into one cluster: the plain fit, nothing reported", () => {
    const chain = Array.from({ length: 14 }, (_, i) => item(`c${i}`, i * 450, 1000));
    expect(clusters(chain)).toHaveLength(1);
    const plan = fitPlan(chain, SIZE, PAD);
    expect(plan.partial).toBe(false);
    expect(plan.viewport).toEqual(fitViewport(chain, SIZE, PAD));
  });
});

describe("clusters", () => {
  it("items exactly CLUSTER_GAP apart are separate; one unit closer, together", () => {
    const a = item("a", 0, 0);
    expect(itemGap(a, item("b", 200 + CLUSTER_GAP, 0))).toBe(CLUSTER_GAP);
    expect(clusters([a, item("b", 200 + CLUSTER_GAP, 0)])).toHaveLength(2);
    expect(clusters([a, item("b", 200 + CLUSTER_GAP - 1, 0)])).toHaveLength(1);
    // Vertically too.
    expect(clusters([a, item("b", 0, 200 + CLUSTER_GAP)])).toHaveLength(2);
    expect(clusters([a, item("b", 0, 200 + CLUSTER_GAP - 1)])).toHaveLength(1);
  });

  it("overlapping items (a note inside a frame) have no gap", () => {
    expect(itemGap(item("frame", 0, 0, 640, 400), item("note", 40, 40))).toBe(0);
  });

  it("links through neighbours (a chain), and keeps input order", () => {
    const [a, b, c] = [item("a", 0, 0), item("b", 700, 0), item("c", 1400, 0)];
    expect(clusters([c, a, b])).toEqual([[c, a, b]]);
  });
});

describe("zoom to selection", () => {
  it("never zooms in past FIT_MAX_ZOOM", () => {
    const v = selectionViewport([item("tiny", 3000, 2000, 40, 40)], SIZE, PAD);
    expect(v?.zoom).toBe(FIT_MAX_ZOOM);
  });

  it("frames, notes and shapes together all end up in view", () => {
    const frame = { id: "f", x: 1000, y: 1000, w: 640, h: 400 };
    const note = item("n", 1800, 1100);
    const shape = { id: "s", x: 900, y: 1600, w: 160, h: 100 };
    const v = selectionViewport([frame, note, shape], SIZE, PAD);
    expect(v).not.toBeNull();
    for (const x of [frame, note, shape]) expect(inViewport(x, v!, SIZE)).toBe(true);
    expect(v!.zoom).toBeLessThanOrEqual(FIT_MAX_ZOOM);
  });

  it("is off, with a reason, when nothing is selected", () => {
    expect(selectionViewport([], SIZE, PAD)).toBeNull();
    expect(zoomSelectionReason(0)).toBe(ZOOM_SELECTION_HINT);
    expect(zoomSelectionReason(2)).toBeNull();
  });
});

describe("jump to a pointer", () => {
  it("centres the pointer, keeping the zoom", () => {
    const v = jumpViewport({ x: 0, y: 0, zoom: 1.5 }, SIZE, { x: 4000, y: 2500 });
    expect(v.zoom).toBe(1.5);
    const c = viewportCentre(v, SIZE);
    expect(c.x).toBeCloseTo(4000);
    expect(c.y).toBeCloseTo(2500);
  });

  it("raises a low zoom to JUMP_MIN_ZOOM", () => {
    expect(jumpViewport({ x: 0, y: 0, zoom: 0.2 }, SIZE, { x: 100, y: 100 }).zoom).toBe(JUMP_MIN_ZOOM);
  });
});

describe("animation", () => {
  it("a short duration, and 0 with reduced motion", () => {
    expect(viewDuration(false)).toBe(VIEW_ANIMATION_MS);
    expect(VIEW_ANIMATION_MS).toBeLessThanOrEqual(300);
    expect(viewDuration(true)).toBe(0);
  });
});
