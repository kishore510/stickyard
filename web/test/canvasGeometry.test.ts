import { describe, expect, it } from "vitest";
import { BOARD_HEIGHT, BOARD_WIDTH, NOTE_DEFAULTS, NOTE_DEFAULT_W as NOTE_SIZE } from "@stickyard/shared";
import {
  FIT_MAX_ZOOM,
  MAX_ZOOM,
  MIN_ZOOM,
  PAN_MARGIN,
  STACK_OFFSET,
  WHEEL_BEHAVIOUR,
  boardToFlow,
  clampViewport,
  clampZoom,
  dragThreshold,
  dropPosition,
  fitViewport,
  flowToBoard,
  isDrag,
  keepCentre,
  newNotePosition,
  notesBounds,
  panExtent,
  screenToFlow,
  viewportCentre,
  zoomAround,
  zoomStep,
} from "../src/canvas/geometry";

const phone = { width: 360, height: 560 };
const desk = { width: 1280, height: 720 };
const at = (x: number, y: number) => ({ x, y });

describe("flow <-> board coordinates", () => {
  it("a note's board position is its flow position", () => {
    expect(boardToFlow({ x: 40, y: 60 })).toEqual({ x: 40, y: 60 });
  });

  it("flow positions become whole board units, clamped so the note stays on the board", () => {
    expect(flowToBoard(at(40.4, 59.6))).toEqual({ x: 40, y: 60 });
    expect(flowToBoard(at(-50, -1))).toEqual({ x: 0, y: 0 });
    expect(flowToBoard(at(BOARD_WIDTH, BOARD_HEIGHT + 500))).toEqual({ x: BOARD_WIDTH - NOTE_SIZE, y: BOARD_HEIGHT - NOTE_SIZE });
    expect(flowToBoard(at(Number.NaN, Infinity))).toEqual({ x: 0, y: 0 });
  });

  it("round-trips any position already on the board", () => {
    for (const p of [at(0, 0), at(123, 456), at(BOARD_WIDTH - NOTE_SIZE, BOARD_HEIGHT - NOTE_SIZE)]) {
      expect(flowToBoard(boardToFlow(p))).toEqual(p);
    }
  });

  it("screen points map through the viewport transform", () => {
    expect(screenToFlow(at(100, 50), { x: 20, y: 10, zoom: 2 })).toEqual({ x: 40, y: 20 });
    expect(viewportCentre({ x: -100, y: -200, zoom: 0.5 }, phone)).toEqual({ x: (180 + 100) / 0.5, y: (280 + 200) / 0.5 });
  });
});

describe("zoom", () => {
  it("is clamped to the allowed range", () => {
    expect(MIN_ZOOM).toBeGreaterThan(0);
    expect(MAX_ZOOM).toBeGreaterThan(1);
    expect(clampZoom(0.001)).toBe(MIN_ZOOM);
    expect(clampZoom(100)).toBe(MAX_ZOOM);
    expect(clampZoom(1)).toBe(1);
    expect(clampZoom(Number.NaN)).toBe(1);
  });

  it("the minimum zoom shows the whole board's width only on screens wider than BOARD_WIDTH x MIN_ZOOM (v16: 640 px, by decision)", () => {
    // Decided with the 6400 x 4000 board (protocol v16): MIN_ZOOM stays 0.1. The goal is room to
    // work, not the whole board on screen, so a phone sees part of the board even zoomed right out.
    expect(MIN_ZOOM * BOARD_WIDTH).toBeGreaterThan(phone.width);
    expect(MIN_ZOOM * (BOARD_WIDTH + 2 * PAN_MARGIN)).toBeLessThanOrEqual(desk.width);
  });

  it("steps in and out, clamped", () => {
    expect(zoomStep(1, 1)).toBeGreaterThan(1);
    expect(zoomStep(1, -1)).toBeLessThan(1);
    expect(zoomStep(zoomStep(1, 1), -1)).toBeCloseTo(1);
    expect(zoomStep(MAX_ZOOM, 1)).toBe(MAX_ZOOM);
    expect(zoomStep(MIN_ZOOM, -1)).toBe(MIN_ZOOM);
  });

  it("zooming keeps the viewport centre fixed", () => {
    const v = { x: -300, y: -200, zoom: 1 };
    const next = zoomAround(v, desk, 2);
    expect(next.zoom).toBe(2);
    expect(viewportCentre(next, desk).x).toBeCloseTo(viewportCentre(v, desk).x);
    expect(viewportCentre(next, desk).y).toBeCloseTo(viewportCentre(v, desk).y);
  });

  it("the mouse wheel pans by default (one constant flips it to zoom)", () => {
    expect(WHEEL_BEHAVIOUR).toBe("pan");
  });
});

describe("fit to notes", () => {
  it("bounds cover every note's full square", () => {
    expect(notesBounds([])).toBeNull();
    expect(notesBounds([at(100, 200), at(400, 50)])).toEqual({ x: 100, y: 50, width: 300 + NOTE_SIZE, height: 150 + NOTE_SIZE });
  });

  it("centres the notes, never zooming in past the fit maximum", () => {
    const v = fitViewport([at(1000, 800)], desk, 32);
    expect(v.zoom).toBe(FIT_MAX_ZOOM);
    const c = viewportCentre(v, desk);
    expect(c.x).toBeCloseTo(1000 + NOTE_SIZE / 2);
    expect(c.y).toBeCloseTo(800 + NOTE_SIZE / 2);
  });

  it("zooms out so far-apart notes all fit inside the padding", () => {
    const notes = [at(0, 0), at(BOARD_WIDTH - NOTE_SIZE, BOARD_HEIGHT - NOTE_SIZE)];
    const v = fitViewport(notes, desk, 16);
    expect(v.zoom).toBeLessThan(1);
    expect(v.zoom).toBeGreaterThanOrEqual(MIN_ZOOM);
    // Left and right board edges land inside the screen.
    expect(v.x).toBeGreaterThanOrEqual(0);
    expect(v.x + BOARD_WIDTH * v.zoom).toBeLessThanOrEqual(desk.width);
  });

  it("notes in opposite corners on a phone: fit stops at MIN_ZOOM, centred between them (they can't both show)", () => {
    const notes = [at(0, 0), at(BOARD_WIDTH - NOTE_SIZE, BOARD_HEIGHT - NOTE_SIZE)];
    const v = fitViewport(notes, phone, 16);
    expect(v.zoom).toBe(MIN_ZOOM);
    const c = viewportCentre(v, phone);
    expect(c.x).toBeCloseTo(BOARD_WIDTH / 2);
    expect(c.y).toBeCloseTo(BOARD_HEIGHT / 2);
  });

  it("an empty board is centred on the board, never top-left", () => {
    const v = fitViewport([], desk, 32);
    const c = viewportCentre(v, desk);
    expect(c.x).toBeCloseTo(BOARD_WIDTH / 2);
    expect(c.y).toBeCloseTo(BOARD_HEIGHT / 2);
  });

  it("copes with a zero-sized container (before layout)", () => {
    const v = fitViewport([at(10, 10)], { width: 0, height: 0 }, 32);
    expect(Number.isFinite(v.x) && Number.isFinite(v.y)).toBe(true);
    expect(v.zoom).toBeGreaterThanOrEqual(MIN_ZOOM);
  });
});

describe("pan limits", () => {
  it("the extent is the board plus a margin", () => {
    expect(panExtent()).toEqual([
      [-PAN_MARGIN, -PAN_MARGIN],
      [BOARD_WIDTH + PAN_MARGIN, BOARD_HEIGHT + PAN_MARGIN],
    ]);
  });

  it("a viewport panned far away is pulled back to the edge of the extent", () => {
    const far = clampViewport({ x: 99_999, y: 99_999, zoom: 1 }, desk);
    // The screen's top-left shows the extent's top-left corner, no further.
    expect(screenToFlow(at(0, 0), far)).toEqual({ x: -PAN_MARGIN, y: -PAN_MARGIN });
    const other = clampViewport({ x: -99_999, y: -99_999, zoom: 1 }, desk);
    const bottomRight = screenToFlow(at(desk.width, desk.height), other);
    expect(bottomRight.x).toBeCloseTo(BOARD_WIDTH + PAN_MARGIN);
    expect(bottomRight.y).toBeCloseTo(BOARD_HEIGHT + PAN_MARGIN);
  });

  it("when the whole extent fits on screen, it is centred", () => {
    const v = clampViewport({ x: 0, y: 0, zoom: MIN_ZOOM }, desk);
    const c = viewportCentre(v, desk);
    expect(c.x).toBeCloseTo(BOARD_WIDTH / 2);
    expect(c.y).toBeCloseTo(BOARD_HEIGHT / 2);
  });

  it("a viewport inside the limits is unchanged", () => {
    const v = { x: -500, y: -400, zoom: 1 };
    expect(clampViewport(v, desk)).toEqual(v);
  });
});

describe("new note placement", () => {
  it("centres the note on the viewport centre", () => {
    expect(newNotePosition(at(1000, 700), [])).toEqual({ x: 1000 - NOTE_SIZE / 2, y: 700 - NOTE_SIZE / 2 });
  });

  it("steps down and right while the spot is taken", () => {
    const first = newNotePosition(at(1000, 700), []);
    const second = newNotePosition(at(1000, 700), [first]);
    expect(second).toEqual({ x: first.x + STACK_OFFSET, y: first.y + STACK_OFFSET });
    const third = newNotePosition(at(1000, 700), [first, second]);
    expect(third).toEqual({ x: first.x + 2 * STACK_OFFSET, y: first.y + 2 * STACK_OFFSET });
  });

  it("a note nearly on the spot counts as taken; one well away doesn't", () => {
    const spot = newNotePosition(at(1000, 700), []);
    expect(newNotePosition(at(1000, 700), [at(spot.x + 3, spot.y - 2)])).not.toEqual(spot);
    expect(newNotePosition(at(1000, 700), [at(spot.x + NOTE_SIZE, spot.y)])).toEqual(spot);
  });

  it("is clamped to the board, and gives up stepping after a while", () => {
    const corner = { x: BOARD_WIDTH - NOTE_SIZE, y: BOARD_HEIGHT - NOTE_SIZE };
    expect(newNotePosition(at(BOARD_WIDTH + 900, BOARD_HEIGHT + 900), [])).toEqual(corner);
    // Stepping can't leave the board, so a taken corner is reused rather than looping forever.
    expect(newNotePosition(at(BOARD_WIDTH + 900, BOARD_HEIGHT + 900), [corner])).toEqual(corner);
  });
});

describe("tap or drag", () => {
  it("movement under the threshold is a tap", () => {
    expect(isDrag(0, 0, 4)).toBe(false);
    expect(isDrag(2, 2, 4)).toBe(false);
    expect(isDrag(3, 3, 4)).toBe(true);
    expect(isDrag(-4, 0, 4)).toBe(true);
  });

  it("touch gets a bigger threshold than a mouse", () => {
    expect(dragThreshold(true)).toBeGreaterThan(dragThreshold(false));
    expect(dragThreshold(false)).toBeGreaterThan(0);
  });
});

describe("dropping a palette tile on the board", () => {
  const rect = { x: 240, y: 56, width: 760, height: 600 };
  const size = { width: NOTE_SIZE, height: NOTE_SIZE };

  it("converts the pointer to board units and centres the note on it", () => {
    // Pointer 300px right and 200px down inside the canvas, view at zoom 1 offset by (-100, -50).
    const v = { x: -100, y: -50, zoom: 1 };
    expect(dropPosition(at(540, 256), rect, v, size)).toEqual({ x: 400 - NOTE_SIZE / 2, y: 250 - NOTE_SIZE / 2 });
  });

  it("follows the zoom", () => {
    const v = { x: 0, y: 0, zoom: 0.5 };
    expect(dropPosition(at(240 + 300, 56 + 200), rect, v, size)).toEqual({ x: 600 - NOTE_SIZE / 2, y: 400 - NOTE_SIZE / 2 });
  });

  it("is clamped so the note stays on the board", () => {
    const v = { x: 0, y: 0, zoom: 1 };
    expect(dropPosition(at(241, 57), rect, v, size)).toEqual({ x: 0, y: 0 });
    const far = { x: -(BOARD_WIDTH - 100), y: -(BOARD_HEIGHT - 100), zoom: 1 };
    expect(dropPosition(at(240 + 700, 56 + 500), rect, far, size)).toEqual({ x: BOARD_WIDTH - NOTE_SIZE, y: BOARD_HEIGHT - NOTE_SIZE });
  });

  it("a drop outside the canvas (back on a panel) adds nothing", () => {
    const v = { x: 0, y: 0, zoom: 1 };
    expect(dropPosition(at(100, 300), rect, v, size)).toBeNull();
    expect(dropPosition(at(1100, 300), rect, v, size)).toBeNull();
    expect(dropPosition(at(500, 20), rect, v, size)).toBeNull();
  });
});

describe("panels opening, closing or resizing", () => {
  it("keep the same board point at the centre of the canvas", () => {
    const v = { x: -300, y: -120, zoom: 0.8 };
    const before = { width: 760, height: 600 };
    const centre = viewportCentre(v, before);
    for (const after of [{ width: 1040, height: 600 }, { width: 500, height: 600 }, { width: 760, height: 480 }]) {
      const next = keepCentre(v, before, after);
      expect(next.zoom).toBe(v.zoom);
      expect(viewportCentre(next, after).x).toBeCloseTo(centre.x, 6);
      expect(viewportCentre(next, after).y).toBeCloseTo(centre.y, 6);
    }
  });

  it("an unchanged size, or a container not laid out yet, leaves the viewport alone", () => {
    const v = { x: -300, y: -120, zoom: 0.8 };
    expect(keepCentre(v, { width: 760, height: 600 }, { width: 760, height: 600 })).toBe(v);
    expect(keepCentre(v, { width: 0, height: 0 }, { width: 760, height: 600 })).toBe(v);
  });
});

describe("per-note sizes (protocol v4)", () => {
  const sized = (x: number, y: number, w: number, h: number) => ({ ...NOTE_DEFAULTS, x, y, w, h });

  it("flowToBoard clamps with the note's own size", () => {
    expect(flowToBoard(at(BOARD_WIDTH, BOARD_HEIGHT), { width: 480, height: 96 })).toEqual({ x: BOARD_WIDTH - 480, y: BOARD_HEIGHT - 96 });
    expect(flowToBoard(at(BOARD_WIDTH, BOARD_HEIGHT), { width: 96, height: 96 })).toEqual({ x: BOARD_WIDTH - 96, y: BOARD_HEIGHT - 96 });
  });

  it("fit-to-notes bounds use each note's size", () => {
    expect(notesBounds([sized(100, 200, 400, 300), sized(600, 50, 96, 96)])).toEqual({ x: 100, y: 50, width: 596, height: 450 });
  });

  it("fit centres on the sized bounds", () => {
    const v = fitViewport([sized(1000, 800, 400, 200)], desk, 32);
    const c = viewportCentre(v, desk);
    expect(c.x).toBeCloseTo(1200);
    expect(c.y).toBeCloseTo(900);
  });

  it("add-at-centre places a default-size note and steps past a taken spot whatever that note's size", () => {
    const spot = newNotePosition(at(1000, 700), []);
    expect(spot).toEqual({ x: 1000 - NOTE_SIZE / 2, y: 700 - NOTE_SIZE / 2 });
    expect(newNotePosition(at(1000, 700), [sized(spot.x, spot.y, 480, 480)])).toEqual({ x: spot.x + STACK_OFFSET, y: spot.y + STACK_OFFSET });
  });

  it("drop placement centres and clamps with the size it's given", () => {
    const rect = { x: 0, y: 0, width: 800, height: 600 };
    const far = { x: -(BOARD_WIDTH - 100), y: -(BOARD_HEIGHT - 100), zoom: 1 };
    expect(dropPosition(at(700, 500), rect, far, { width: 300, height: 200 })).toEqual({ x: BOARD_WIDTH - 300, y: BOARD_HEIGHT - 200 });
  });
});
