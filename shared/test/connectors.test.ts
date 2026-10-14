import { describe, expect, it } from "vitest";
import {
  BOARD_HEIGHT,
  BOARD_WIDTH,
  BOARD_WRITES,
  CONNECTOR_ANCHORS,
  CONNECTOR_DASHES,
  CONNECTOR_DEFAULTS,
  CONNECTOR_HEADS,
  CONNECTOR_INKS,
  CONNECTOR_ROUTES,
  CONNECTOR_STYLE_FIELDS,
  CONNECTOR_TOLERANCE,
  CONNECTOR_UPDATE_FIELDS,
  CONNECTOR_WIDTHS,
  CONNECTORS_SNAPSHOT_MAX_BYTES,
  HOST_ONLY,
  MAX_CONNECTORS_PER_ROOM,
  MAX_MESSAGE_BYTES,
  MAX_SERVER_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  SERVER_MESSAGES,
  SHAPE_STROKES,
  anchorPoint,
  clampConnectorPoint,
  clientMessageSchema,
  encodeMessage,
  endReference,
  errorCodeSchema,
  errorMessageSchema,
  isBound,
  resolveConnector,
  serverMessageSchema,
  utf8Length,
  type Box,
  type ConnectorEnd,
} from "../src";

/*
 * Protocol v21 (connectors, part 1 of 2: relay and shared). A connector joins two endpoints, each
 * free (a board point) or bound to a note or shape (an anchor on its box). Generic fixtures only;
 * a hostile string stands in wherever text could appear.
 */

const HOSTILE = "<img src=x onerror=alert(1)>";
const ID = "AAAAAAAAAAAAAAAA";
const OTHER = "BBBBBBBBBBBBBBBB";
const ok = (m: unknown) => clientMessageSchema.safeParse(m).success;
const serverOk = (m: unknown) => serverMessageSchema.safeParse(m).success;
const style = { route: "straight", dash: "solid", width: "medium", ink: "neutral", startHead: "none", endHead: "arrow" } as const;
const add = (extra: Record<string, unknown> = {}) => ({ type: "connectorAdd", clientRef: "c1", start: { x: 10, y: 20 }, end: { item: ID, anchor: "auto" }, ...style, ...extra });
const connector = (extra: Record<string, unknown> = {}) => ({ id: ID, start: { x: 10, y: 20 }, end: { item: OTHER, anchor: "left" }, ...style, rev: 1, authorId: OTHER, ...extra });

describe("protocol v21", () => {
  it("is version 21 or later", () => {
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(21);
  });

  it("key sets: anchors, routes, dashes, widths, inks (the shape border colours) and heads", () => {
    expect(CONNECTOR_ANCHORS).toEqual(["auto", "top", "right", "bottom", "left"]);
    expect(CONNECTOR_ROUTES).toEqual(["straight", "elbow"]);
    expect(CONNECTOR_DASHES).toEqual(["solid", "dashed", "dotted"]);
    expect(CONNECTOR_WIDTHS).toEqual(["thin", "medium", "thick"]);
    expect(CONNECTOR_INKS).toEqual(SHAPE_STROKES);
    expect(CONNECTOR_HEADS).toEqual(["none", "arrow"]);
    expect(CONNECTOR_STYLE_FIELDS).toEqual(["route", "dash", "width", "ink", "startHead", "endHead"]);
    expect(CONNECTOR_UPDATE_FIELDS).toEqual(["start", "end", ...CONNECTOR_STYLE_FIELDS]);
    expect(CONNECTOR_DEFAULTS).toEqual(style);
  });

  it(`a room holds at most ${MAX_CONNECTORS_PER_ROOM} connectors`, () => {
    expect(MAX_CONNECTORS_PER_ROOM).toBe(100);
  });

  it("all three client messages change the board (a lock refuses them) and none is host-only", () => {
    for (const t of ["connectorAdd", "connectorUpdate", "connectorDelete"] as const) {
      expect(BOARD_WRITES[t]).toBe(true);
      expect(HOST_ONLY).not.toContain(t);
    }
  });

  it("messages that can name a note (a bound endpoint) are note-carrying; a delete names only the connector", () => {
    expect(SERVER_MESSAGES.connectorsSnapshot.carriesNoteContent).toBe(true);
    expect(SERVER_MESSAGES.connectorAdded.carriesNoteContent).toBe(true);
    expect(SERVER_MESSAGES.connectorUpdated.carriesNoteContent).toBe(true);
    expect(SERVER_MESSAGES.connectorDeleted.carriesNoteContent).toBe(false);
  });

  it("new error codes connectors_full and unknown_item; errors may name a connector", () => {
    for (const code of ["connectors_full", "unknown_item"]) expect(errorCodeSchema.safeParse(code).success).toBe(true);
    expect(errorMessageSchema.safeParse({ type: "error", code: "unknown_item", message: "No.", connectorId: ID }).success).toBe(true);
    expect(errorMessageSchema.safeParse({ type: "error", code: "unknown_item", message: "No.", connectorId: HOSTILE }).success).toBe(false);
  });
});

describe("connectorAdd", () => {
  it("full content: free and bound endpoints in any mix, every style key", () => {
    expect(ok(add())).toBe(true);
    expect(ok(add({ start: { item: ID, anchor: "top" }, end: { item: OTHER, anchor: "bottom" } }))).toBe(true);
    expect(ok(add({ start: { x: 0, y: 0 }, end: { x: BOARD_WIDTH, y: BOARD_HEIGHT } }))).toBe(true);
    for (const anchor of CONNECTOR_ANCHORS) expect(ok(add({ end: { item: ID, anchor } }))).toBe(true);
    for (const route of CONNECTOR_ROUTES) expect(ok(add({ route }))).toBe(true);
    for (const dash of CONNECTOR_DASHES) expect(ok(add({ dash }))).toBe(true);
    for (const width of CONNECTOR_WIDTHS) expect(ok(add({ width }))).toBe(true);
    for (const ink of CONNECTOR_INKS) expect(ok(add({ ink }))).toBe(true);
    for (const head of CONNECTOR_HEADS) expect(ok(add({ startHead: head, endHead: head }))).toBe(true);
  });

  it("free points may be a little past the edge (the relay clamps them), and fractional; never NaN, Infinity or far off", () => {
    expect(ok(add({ start: { x: -CONNECTOR_TOLERANCE, y: BOARD_HEIGHT + CONNECTOR_TOLERANCE } }))).toBe(true);
    expect(ok(add({ start: { x: 10.4, y: 20.6 } }))).toBe(true);
    for (const x of [-CONNECTOR_TOLERANCE - 1, BOARD_WIDTH + CONNECTOR_TOLERANCE + 1, Number.NaN, Number.POSITIVE_INFINITY, "10", null]) {
      expect(ok(add({ start: { x, y: 10 } }))).toBe(false);
    }
  });

  it("every style field is required (full content) and is a key, never CSS", () => {
    for (const field of CONNECTOR_STYLE_FIELDS) {
      const { [field]: _, ...rest } = add();
      expect(ok(rest), field).toBe(false);
      expect(ok(add({ [field]: HOSTILE })), field).toBe(false);
    }
    for (const ink of ["#ff0000", "red", "var(--x)", "Neutral"]) expect(ok(add({ ink }))).toBe(false);
  });

  it("strict: no id, rev, author, z or claimed colour; endpoints can't mix free and bound", () => {
    for (const extra of [{ id: ID }, { rev: 1 }, { authorId: ID }, { z: 5 }, { text: HOSTILE }]) expect(ok(add(extra))).toBe(false);
    expect(ok(add({ start: { x: 1, y: 2, item: ID, anchor: "auto" } }))).toBe(false);
    expect(ok(add({ start: { item: ID } }))).toBe(false);
    expect(ok(add({ start: { anchor: "auto" } }))).toBe(false);
    expect(ok(add({ start: { x: 1 } }))).toBe(false);
    expect(ok(add({ start: { item: ID, anchor: "centre" } }))).toBe(false);
    expect(ok(add({ start: { item: HOSTILE, anchor: "auto" } }))).toBe(false);
    expect(ok(add({ start: { item: `${ID}A`, anchor: "auto" } }))).toBe(false);
    expect(ok(add({ clientRef: HOSTILE }))).toBe(false);
  });

  it("the largest connectorAdd fits a client message many times over", () => {
    const m = add({ clientRef: "r".repeat(32), start: { item: ID, anchor: "bottom" }, end: { x: -63.123456789, y: 4063.987654321 }, route: "straight", dash: "dashed", ink: "neutral" });
    expect(ok(m)).toBe(true);
    expect(utf8Length(JSON.stringify(m))).toBeLessThan(MAX_MESSAGE_BYTES / 8);
  });
});

describe("connectorUpdate and connectorDelete", () => {
  it("connectorUpdate takes any endpoint or style field, at least one, and nothing else", () => {
    const base = { type: "connectorUpdate", id: ID };
    expect(ok(base)).toBe(false);
    expect(ok({ ...base, start: { x: 5, y: 5 } })).toBe(true);
    expect(ok({ ...base, end: { item: OTHER, anchor: "right" } })).toBe(true);
    for (const field of CONNECTOR_STYLE_FIELDS) expect(ok({ ...base, [field]: style[field] }), field).toBe(true);
    expect(ok({ ...base, ...style, start: { x: 1, y: 1 }, end: { x: 2, y: 2 } })).toBe(true);
    for (const extra of [{ rev: 3 }, { authorId: ID }, { clientRef: "c1" }, { z: 1 }]) expect(ok({ ...base, dash: "dotted", ...extra })).toBe(false);
    expect(ok({ ...base, id: HOSTILE, dash: "dotted" })).toBe(false);
    expect(ok({ ...base, dash: HOSTILE })).toBe(false);
  });

  it("connectorDelete: an id, strict", () => {
    expect(ok({ type: "connectorDelete", id: ID })).toBe(true);
    expect(ok({ type: "connectorDelete", id: HOSTILE })).toBe(false);
    expect(ok({ type: "connectorDelete", id: ID, all: true })).toBe(false);
    expect(ok({ type: "connectorDelete" })).toBe(false);
  });
});

describe("server messages", () => {
  it("a connector as sent: whole-unit free points on the board, bound ends with no coordinates, keys, rev and author", () => {
    expect(serverOk({ type: "connectorAdded", connector: connector() })).toBe(true);
    expect(serverOk({ type: "connectorAdded", connector: connector(), clientRef: "c1" })).toBe(true);
    expect(serverOk({ type: "connectorUpdated", connector: connector({ start: { x: BOARD_WIDTH, y: BOARD_HEIGHT } }) })).toBe(true);
    for (const start of [{ x: -1, y: 0 }, { x: BOARD_WIDTH + 1, y: 0 }, { x: 1.5, y: 0 }, { x: 1, y: 2, item: ID, anchor: "auto" }]) {
      expect(serverOk({ type: "connectorUpdated", connector: connector({ start }) })).toBe(false);
    }
    expect(serverOk({ type: "connectorUpdated", connector: connector({ rev: 0 }) })).toBe(false);
    expect(serverOk({ type: "connectorUpdated", connector: connector({ ink: HOSTILE }) })).toBe(false);
    expect(serverOk({ type: "connectorDeleted", id: ID })).toBe(true);
    expect(serverOk({ type: "connectorDeleted", id: HOSTILE })).toBe(false);
  });

  it(`connectorsSnapshot: up to ${MAX_CONNECTORS_PER_ROOM} connectors, strict`, () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => connector({ id: `c${String(i).padStart(15, "0")}` }));
    expect(serverOk({ type: "connectorsSnapshot", connectors: [] })).toBe(true);
    expect(serverOk({ type: "connectorsSnapshot", connectors: many(MAX_CONNECTORS_PER_ROOM) })).toBe(true);
    expect(serverOk({ type: "connectorsSnapshot", connectors: many(MAX_CONNECTORS_PER_ROOM + 1) })).toBe(false);
    expect(serverOk({ type: "connectorsSnapshot", connectors: [], extra: 1 })).toBe(false);
  });

  it(`the worst-case connectorsSnapshot stays under 90% of its ${CONNECTORS_SNAPSHOT_MAX_BYTES / 1024} KiB test cap (and far under the server cap)`, () => {
    // Every connector at its longest: both ends bound (16-character ids, the longest anchor), the
    // longest key of every style field, rev at its largest.
    const longest = (keys: readonly string[]) => keys.reduce((a, b) => (b.length > a.length ? b : a));
    const connectors = Array.from({ length: MAX_CONNECTORS_PER_ROOM }, (_, i) => ({
      id: `c${String(i).padStart(15, "0")}`,
      start: { item: `s${String(i).padStart(15, "0")}`, anchor: longest(CONNECTOR_ANCHORS) },
      end: { item: `e${String(i).padStart(15, "0")}`, anchor: longest(CONNECTOR_ANCHORS) },
      route: longest(CONNECTOR_ROUTES),
      dash: longest(CONNECTOR_DASHES),
      width: longest(CONNECTOR_WIDTHS),
      ink: longest(CONNECTOR_INKS),
      startHead: longest(CONNECTOR_HEADS),
      endHead: longest(CONNECTOR_HEADS),
      rev: Number.MAX_SAFE_INTEGER,
      authorId: ID,
    }));
    const message = serverMessageSchema.parse({ type: "connectorsSnapshot", connectors });
    const bytes = utf8Length(encodeMessage(message));
    // Free ends are shorter than bound ones (4-digit coordinates): a free one can't be the worst case.
    expect(utf8Length(JSON.stringify({ x: BOARD_WIDTH, y: BOARD_HEIGHT }))).toBeLessThan(utf8Length(JSON.stringify(connectors[0]!.start)));
    expect(bytes).toBeLessThan(CONNECTORS_SNAPSHOT_MAX_BYTES * 0.9);
    expect(bytes).toBeLessThan(MAX_SERVER_MESSAGE_BYTES / 8);
  });
});

/* ── Geometry: one pure function, used by the relay now and the page in part 2 ── */

const box: Box = { x: 100, y: 200, w: 200, h: 100 }; // centre (200, 250)

describe("anchorPoint", () => {
  it("fixed anchors are the middle of that side, whatever the other point", () => {
    for (const other of [{ x: 0, y: 0 }, { x: 5000, y: 3000 }]) {
      expect(anchorPoint(box, "top", other)).toEqual({ x: 200, y: 200 });
      expect(anchorPoint(box, "right", other)).toEqual({ x: 300, y: 250 });
      expect(anchorPoint(box, "bottom", other)).toEqual({ x: 200, y: 300 });
      expect(anchorPoint(box, "left", other)).toEqual({ x: 100, y: 250 });
    }
  });

  it("auto: where the line from the centre towards the other point leaves the box", () => {
    expect(anchorPoint(box, "auto", { x: 1000, y: 250 })).toEqual({ x: 300, y: 250 });
    expect(anchorPoint(box, "auto", { x: -50, y: 250 })).toEqual({ x: 100, y: 250 });
    expect(anchorPoint(box, "auto", { x: 200, y: 0 })).toEqual({ x: 200, y: 200 });
    expect(anchorPoint(box, "auto", { x: 200, y: 900 })).toEqual({ x: 200, y: 300 });
    // Up and to the right at 45 degrees: the top edge is reached first on this wide box.
    expect(anchorPoint(box, "auto", { x: 400, y: 50 })).toEqual({ x: 250, y: 200 });
    // Shallow: the right edge first.
    expect(anchorPoint(box, "auto", { x: 600, y: 350 })).toEqual({ x: 300, y: 275 });
    // Through a corner exactly.
    expect(anchorPoint(box, "auto", { x: 400, y: 350 })).toEqual({ x: 300, y: 300 });
  });

  it("auto with the other point inside the box still lands on the edge, in its direction", () => {
    expect(anchorPoint(box, "auto", { x: 210, y: 250 })).toEqual({ x: 300, y: 250 });
    expect(anchorPoint(box, "auto", { x: 200, y: 240 })).toEqual({ x: 200, y: 200 });
  });

  it("auto with the other point at the centre: the top middle (a fixed, documented choice)", () => {
    expect(anchorPoint(box, "auto", { x: 200, y: 250 })).toEqual({ x: 200, y: 200 });
  });

  it("is pure: the box and the point are not changed", () => {
    const b = { ...box };
    const p = { x: 900, y: 900 };
    anchorPoint(b, "auto", p);
    expect(b).toEqual(box);
    expect(p).toEqual({ x: 900, y: 900 });
  });
});

describe("resolving endpoints", () => {
  const boxes = new Map<string, Box>([
    ["note", { x: 100, y: 100, w: 160, h: 160 }], // centre (180, 180)
    ["shape", { x: 1000, y: 100, w: 200, h: 120 }], // centre (1100, 160)
  ]);
  const boxOf = (id: string) => boxes.get(id);

  it("isBound tells the two kinds apart", () => {
    const free: ConnectorEnd = { x: 1, y: 2 };
    const bound: ConnectorEnd = { item: ID, anchor: "auto" };
    expect(isBound(free)).toBe(false);
    expect(isBound(bound)).toBe(true);
  });

  it("an end's reference point: a free point itself; a fixed anchor its point; auto the item's centre; a missing item null", () => {
    expect(endReference({ x: 7, y: 8 }, boxOf)).toEqual({ x: 7, y: 8 });
    expect(endReference({ item: "note", anchor: "right" }, boxOf)).toEqual({ x: 260, y: 180 });
    expect(endReference({ item: "note", anchor: "auto" }, boxOf)).toEqual({ x: 180, y: 180 });
    expect(endReference({ item: "gone", anchor: "auto" }, boxOf)).toBeNull();
  });

  it("free to free: the points themselves", () => {
    expect(resolveConnector({ start: { x: 1, y: 2 }, end: { x: 3, y: 4 } }, boxOf)).toEqual({ start: { x: 1, y: 2 }, end: { x: 3, y: 4 } });
  });

  it("auto to a free point aims at the point; auto to auto aims at each other's centre", () => {
    expect(resolveConnector({ start: { item: "note", anchor: "auto" }, end: { x: 1000, y: 180 } }, boxOf)).toEqual({ start: { x: 260, y: 180 }, end: { x: 1000, y: 180 } });
    const both = resolveConnector({ start: { item: "note", anchor: "auto" }, end: { item: "shape", anchor: "auto" } }, boxOf);
    expect(both?.start.x).toBe(260);
    expect(both?.end.x).toBe(1000);
  });

  it("a fixed anchor is used as the other end's aim", () => {
    // The note's bottom middle (180, 260); the shape's auto aims at it.
    const r = resolveConnector({ start: { item: "note", anchor: "bottom" }, end: { item: "shape", anchor: "auto" } }, boxOf);
    expect(r?.start).toEqual({ x: 180, y: 260 });
    expect(r?.end).toEqual(anchorPoint(boxes.get("shape")!, "auto", { x: 180, y: 260 }));
  });

  it("null when a bound item isn't there", () => {
    expect(resolveConnector({ start: { item: "gone", anchor: "top" }, end: { x: 3, y: 4 } }, boxOf)).toBeNull();
  });
});

describe("clampConnectorPoint", () => {
  it("rounds to whole units and clamps onto the board, edges included", () => {
    expect(clampConnectorPoint(10.4, 20.6)).toEqual({ x: 10, y: 21 });
    expect(clampConnectorPoint(-40, BOARD_HEIGHT + 40)).toEqual({ x: 0, y: BOARD_HEIGHT });
    expect(clampConnectorPoint(BOARD_WIDTH, 0)).toEqual({ x: BOARD_WIDTH, y: 0 });
    expect(clampConnectorPoint(Number.NaN, Number.POSITIVE_INFINITY)).toEqual({ x: 0, y: 0 });
  });
});
