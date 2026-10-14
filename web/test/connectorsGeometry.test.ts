import { describe, expect, it } from "vitest";
import { BOARD_WIDTH, CONNECTOR_DEFAULTS, type Connector } from "@stickyard/shared";
import {
  SNAP_PX,
  boxOfBoard,
  connectorLabel,
  endAt,
  endsProblem,
  freedArrows,
  marqueeConnectors,
  moveFreeArrow,
  resolveShown,
  reversedPatch,
  routePoints,
  snapEnd,
} from "../src/connectors/geometry";
import { applyConnectorsSnapshot } from "../src/connectors/board";
import { applySnapshot, EMPTY_BOARD, moveLocal } from "../src/notes/board";
import { applyShapesSnapshot } from "../src/shapes/board";
import { cid, connector, nid, note, shape, sid } from "./helpers/fakeRelay";

/* Arrows part 2: geometry the canvas draws with, snapping, attaching, freeing, marquee. */

const free = (x: number, y: number) => ({ x, y });
const bound = (item: string, anchor: "auto" | "top" | "right" | "bottom" | "left" = "auto") => ({ item, anchor });

// note(1) is at 10,20 160x160; shape(1) is a rect at 310,300 200x120.
const board = (...arrows: Connector[]) => applyConnectorsSnapshot(applyShapesSnapshot(applySnapshot(EMPTY_BOARD, [note(1)]), [shape(1)]), arrows);
const items = () => [
  { id: nid(1), x: 10, y: 20, w: 160, h: 160, z: 1 },
  { id: sid(1), x: 310, y: 300, w: 200, h: 120, z: 101 },
];

describe("re-route from item moves (nothing stored for the arrow)", () => {
  it("an attached end follows the note's live position", () => {
    const b = board(connector(1, bound(nid(1), "right"), free(600, 100)));
    expect(resolveShown(b.connectors[0]!.connector, boxOfBoard(b))?.start).toEqual({ x: 170, y: 100 });
    const moved = moveLocal(b, nid(1), 110, 20);
    expect(moved.connectors).toBe(b.connectors);
    expect(resolveShown(moved.connectors[0]!.connector, boxOfBoard(moved))?.start).toEqual({ x: 270, y: 100 });
  });

  it("a note deleted here (waiting for the relay) still holds its arrows where it was", () => {
    const b = board(connector(1, bound(nid(1), "right"), free(600, 100)));
    const gone = { ...b, notes: [], removed: [{ ...b.notes[0]!, index: 0 }] };
    expect(resolveShown(gone.connectors[0]!.connector, boxOfBoard(gone))?.start).toEqual({ x: 170, y: 100 });
  });

  it("straight is two points; elbow turns once each way, horizontal first when wider than tall", () => {
    expect(routePoints({ x: 0, y: 0 }, { x: 100, y: 40 }, "straight")).toEqual([
      { x: 0, y: 0 },
      { x: 100, y: 40 },
    ]);
    expect(routePoints({ x: 0, y: 0 }, { x: 100, y: 40 }, "elbow")).toEqual([
      { x: 0, y: 0 },
      { x: 50, y: 0 },
      { x: 50, y: 40 },
      { x: 100, y: 40 },
    ]);
    expect(routePoints({ x: 0, y: 0 }, { x: 40, y: 100 }, "elbow")).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 50 },
      { x: 40, y: 50 },
      { x: 40, y: 100 },
    ]);
  });
});

describe("snap, attach, free and re-attach", () => {
  it("near a note's side middle (in screen pixels) snaps to that side's anchor", () => {
    expect(snapEnd({ x: 172, y: 101 }, items(), 1)).toMatchObject({ item: nid(1), anchor: "right", point: { x: 170, y: 100 } });
    // At 50% zoom the same screen distance is twice as far on the board.
    expect(snapEnd({ x: 170 + 2 * (SNAP_PX - 1), y: 100 }, items(), 0.5)).toMatchObject({ item: nid(1) });
  });

  it("inside a note but away from its sides' middles: auto", () => {
    expect(snapEnd({ x: 60, y: 60 }, items(), 1)).toMatchObject({ item: nid(1), anchor: "auto" });
  });

  it("far from everything: no snap (a free end, clamped onto the board)", () => {
    expect(snapEnd({ x: 1000, y: 1000 }, items(), 1)).toBeNull();
    expect(endAt({ x: BOARD_WIDTH + 30.6, y: -4 }, null)).toEqual({ x: BOARD_WIDTH, y: 0 });
    expect(endAt({ x: 5, y: 5 }, { item: nid(1), anchor: "top", point: { x: 90, y: 20 } })).toEqual(bound(nid(1), "top"));
  });

  it("the topmost item wins where two overlap, and the other end's item can be left out", () => {
    const overlap = [...items(), { id: sid(2), x: 0, y: 0, w: 200, h: 200, z: 300 }];
    expect(snapEnd({ x: 60, y: 60 }, overlap, 1)?.item).toBe(sid(2));
    expect(snapEnd({ x: 60, y: 60 }, overlap, 1, sid(2))?.item).toBe(nid(1));
  });

  it("refuses both ends on one item and zero length, as the relay would", () => {
    const boxOf = boxOfBoard(board());
    expect(endsProblem(bound(nid(1)), bound(nid(1), "top"), boxOf)).toBe("same_item");
    expect(endsProblem(free(5, 5), free(5, 5), boxOf)).toBe("zero");
    expect(endsProblem(bound(nid(1), "right"), free(170, 100), boxOf)).toBe("zero");
    expect(endsProblem(bound(nid(1)), bound(sid(1)), boxOf)).toBeNull();
  });

  it("dragging the line moves both free ends; with an attached end it says why", () => {
    const a = connector(1, free(10, 10), free(100, 100));
    expect(moveFreeArrow(a, 5, -20)).toEqual({ start: free(15, 0), end: free(105, 80) });
    expect(moveFreeArrow(connector(2, bound(nid(1)), free(100, 100)), 5, 5)).toBeNull();
  });

  it("Reverse swaps the ends and the heads", () => {
    const a = connector(1, bound(nid(1)), free(100, 100), { startHead: "none", endHead: "arrow" });
    expect(reversedPatch(a)).toEqual({ start: free(100, 100), end: bound(nid(1)), startHead: "arrow", endHead: "none" });
  });
});

describe("marquee and labels", () => {
  it("takes arrows with both ends inside the box only", () => {
    const list = [
      { id: cid(1), start: { x: 10, y: 10 }, end: { x: 90, y: 90 } },
      { id: cid(2), start: { x: 10, y: 10 }, end: { x: 300, y: 90 } },
    ];
    const box = { x: 0, y: 0, width: 100, height: 100 };
    expect([...marqueeConnectors(list, box, new Set(), false)]).toEqual([cid(1)]);
    expect([...marqueeConnectors(list, { x: 100, y: 100, width: -100, height: -100 }, new Set([cid(2)]), true)]).toEqual([cid(2), cid(1)]);
  });

  it("an accessible name from short, text-only item content (room content is untrusted)", () => {
    const b = applyConnectorsSnapshot(
      applySnapshot(EMPTY_BOARD, [note(1, { text: "<img src=x onerror=alert(1)> and a very long title that keeps going" })]),
      [],
    );
    const label = connectorLabel(connector(1, bound(nid(1)), free(9, 9)), b);
    expect(label).toBe("Arrow from Yellow note: <img src=x onerror=alert(1)> and… to a free end");
    expect(connectorLabel(connector(1, free(1, 1), free(9, 9), { ...CONNECTOR_DEFAULTS, endHead: "none" }), b)).toBe("Line from a free end to a free end");
  });

  it("counts the arrows that would keep a free end when items go (not the arrows going too)", () => {
    const b = board(connector(1, bound(nid(1)), free(600, 100)), connector(2, bound(nid(1)), bound(sid(1))), connector(3, free(1, 1), free(600, 600)));
    expect(freedArrows(b, [nid(1)])).toBe(2);
    expect(freedArrows(b, [nid(1)], [cid(2)])).toBe(1);
    expect(freedArrows(b, [nid(1), sid(1)])).toBe(2);
  });
});
