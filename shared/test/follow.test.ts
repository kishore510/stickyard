import { describe, expect, it } from "vitest";
import {
  BOARD_HEIGHT,
  BOARD_WIDTH,
  BOARD_WRITES,
  FOLLOW_END_REASONS,
  HOST_ONLY,
  MAX_FOLLOWERS,
  MAX_PARTICIPANTS,
  MAX_ZOOM,
  MIN_ZOOM,
  NOTE_DEFAULT_W,
  PROTOCOL_VERSION,
  SERVER_MESSAGES,
  VIEWPORT_MARGIN,
  clampViewportView,
  clientMessageSchema,
  encodeMessage,
  errorCodeSchema,
  serverMessageSchema,
  utf8Length,
} from "../src";

/*
 * Protocol v19 (Follow and Bring to me, part 1): followStart / followStop / viewport / bringToMe
 * from a page; viewportUpdate, followersChanged, followEnded and broughtToMe from the relay. A
 * viewport is the board point at the centre of the sender's view, and its zoom.
 */

const ID = "AAAAAAAAAAAAAAAA";
const ok = (m: unknown) => clientMessageSchema.safeParse(m).success;
const serverOk = (m: unknown) => serverMessageSchema.safeParse(m).success;
const LO = -VIEWPORT_MARGIN;
const HI_X = BOARD_WIDTH + VIEWPORT_MARGIN;
const HI_Y = BOARD_HEIGHT + VIEWPORT_MARGIN;

describe("protocol v19", () => {
  it("is version 19", () => {
    expect(PROTOCOL_VERSION).toBe(19);
  });

  it("zoom bounds live in shared (the web's canvas uses the same numbers)", () => {
    expect(MIN_ZOOM).toBe(0.1);
    expect(MAX_ZOOM).toBe(2);
  });

  it("the viewport margin covers the canvas's pan margin (a note's width past each edge)", () => {
    expect(VIEWPORT_MARGIN).toBeGreaterThanOrEqual(NOTE_DEFAULT_W);
    expect(VIEWPORT_MARGIN).toBeLessThanOrEqual(512);
  });

  it("the follower cap is small, a constant, and below the room size", () => {
    expect(MAX_FOLLOWERS).toBe(10);
    expect(MAX_FOLLOWERS).toBeLessThan(MAX_PARTICIPANTS);
  });

  it("none of the new messages change the board; only bringToMe is host-only", () => {
    for (const type of ["followStart", "followStop", "viewport", "bringToMe"] as const) expect(BOARD_WRITES[type]).toBe(false);
    expect(HOST_ONLY).toContain("bringToMe");
    for (const type of ["followStart", "followStop", "viewport"] as const) expect(HOST_ONLY).not.toContain(type);
  });

  it("new error code followers_full; not_host is reused", () => {
    expect(errorCodeSchema.options).toContain("followers_full");
    expect(errorCodeSchema.options).toContain("not_host");
  });
});

describe("client messages", () => {
  it("followStart: a participant id, strict", () => {
    expect(ok({ type: "followStart", target: ID })).toBe(true);
    expect(ok({ type: "followStart" })).toBe(false);
    expect(ok({ type: "followStart", target: "short" })).toBe(false);
    expect(ok({ type: "followStart", target: "Sam" })).toBe(false);
    expect(ok({ type: "followStart", target: ID, name: "Sam" })).toBe(false);
    expect(ok({ type: "followStart", target: 12 })).toBe(false);
  });

  it("followStop: no fields", () => {
    expect(ok({ type: "followStop" })).toBe(true);
    expect(ok({ type: "followStop", target: ID })).toBe(false);
  });

  it.each(["viewport", "bringToMe"] as const)("%s: finite x and y inside the board plus a margin, zoom within MIN_ZOOM..MAX_ZOOM, strict", (type) => {
    expect(ok({ type, x: 0, y: 0, zoom: 1 })).toBe(true);
    expect(ok({ type, x: 12.5, y: 99.25, zoom: 0.33 })).toBe(true);
    expect(ok({ type, x: LO, y: LO, zoom: MIN_ZOOM })).toBe(true);
    expect(ok({ type, x: HI_X, y: HI_Y, zoom: MAX_ZOOM })).toBe(true);
    expect(ok({ type, x: LO - 1, y: 0, zoom: 1 })).toBe(false);
    expect(ok({ type, x: 0, y: HI_Y + 1, zoom: 1 })).toBe(false);
    expect(ok({ type, x: HI_X + 1, y: 0, zoom: 1 })).toBe(false);
    expect(ok({ type, x: 0, y: 0, zoom: MIN_ZOOM / 2 })).toBe(false);
    expect(ok({ type, x: 0, y: 0, zoom: MAX_ZOOM + 0.01 })).toBe(false);
    expect(ok({ type, x: 0, y: 0, zoom: 0 })).toBe(false);
    expect(ok({ type, x: 0, y: 0, zoom: -1 })).toBe(false);
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, "10", null, undefined]) {
      expect(ok({ type, x: bad, y: 10, zoom: 1 })).toBe(false);
      expect(ok({ type, x: 10, y: bad, zoom: 1 })).toBe(false);
      expect(ok({ type, x: 10, y: 10, zoom: bad })).toBe(false);
    }
    // Nothing a page sends can speak for someone else.
    expect(ok({ type, x: 1, y: 1, zoom: 1, id: ID })).toBe(false);
    expect(ok({ type, x: 1, y: 1, zoom: 1, from: ID })).toBe(false);
    expect(ok({ type, x: 1, y: 1, zoom: 1, target: ID })).toBe(false);
  });
});

describe("server messages", () => {
  it("viewportUpdate: the leader's id, whole units, zoom in bounds, strict", () => {
    expect(serverOk({ type: "viewportUpdate", id: ID, x: 10, y: 20, zoom: 1 })).toBe(true);
    expect(serverOk({ type: "viewportUpdate", id: ID, x: LO, y: HI_Y, zoom: MAX_ZOOM })).toBe(true);
    expect(serverOk({ type: "viewportUpdate", id: ID, x: 10.5, y: 20, zoom: 1 })).toBe(false);
    expect(serverOk({ type: "viewportUpdate", id: ID, x: 10, y: 20, zoom: 3 })).toBe(false);
    expect(serverOk({ type: "viewportUpdate", id: "x", x: 10, y: 20, zoom: 1 })).toBe(false);
    expect(serverOk({ type: "viewportUpdate", id: ID, x: 10, y: 20, zoom: 1, name: "Sam" })).toBe(false);
  });

  it("followersChanged: a count only (0..MAX_FOLLOWERS), never names or ids", () => {
    expect(serverOk({ type: "followersChanged", count: 0 })).toBe(true);
    expect(serverOk({ type: "followersChanged", count: MAX_FOLLOWERS })).toBe(true);
    expect(serverOk({ type: "followersChanged", count: MAX_FOLLOWERS + 1 })).toBe(false);
    expect(serverOk({ type: "followersChanged", count: -1 })).toBe(false);
    expect(serverOk({ type: "followersChanged", count: 1.5 })).toBe(false);
    expect(serverOk({ type: "followersChanged", count: 1, ids: [ID] })).toBe(false);
    expect(serverOk({ type: "followersChanged", count: 1, names: ["Sam"] })).toBe(false);
  });

  it("followEnded: one of the fixed reasons, strict", () => {
    expect([...FOLLOW_END_REASONS]).toEqual(["target_left", "not_found", "self"]);
    for (const reason of FOLLOW_END_REASONS) expect(serverOk({ type: "followEnded", reason })).toBe(true);
    expect(serverOk({ type: "followEnded", reason: "bored" })).toBe(false);
    expect(serverOk({ type: "followEnded" })).toBe(false);
    expect(serverOk({ type: "followEnded", reason: "self", id: ID })).toBe(false);
  });

  it("broughtToMe: the host's id and a viewport, strict", () => {
    expect(serverOk({ type: "broughtToMe", from: ID, x: 1, y: 2, zoom: 0.5 })).toBe(true);
    expect(serverOk({ type: "broughtToMe", from: ID, x: 1, y: 2, zoom: 9 })).toBe(false);
    expect(serverOk({ type: "broughtToMe", from: ID, x: 1.5, y: 2, zoom: 1 })).toBe(false);
    expect(serverOk({ type: "broughtToMe", x: 1, y: 2, zoom: 1 })).toBe(false);
    expect(serverOk({ type: "broughtToMe", from: ID, x: 1, y: 2, zoom: 1, name: "Jo" })).toBe(false);
  });

  it("SERVER_MESSAGES: every new type is registered and carries no note content", () => {
    for (const type of ["viewportUpdate", "followersChanged", "followEnded", "broughtToMe"] as const) {
      expect(SERVER_MESSAGES[type].carriesNoteContent).toBe(false);
    }
    // The registry still lists exactly the schema's variants.
    const variants = serverMessageSchema.options.map((o) => o.shape.type.value).sort();
    expect(Object.keys(SERVER_MESSAGES).sort()).toEqual(variants);
  });
});

describe("clampViewportView", () => {
  it("rounds x and y to whole units, keeps them inside the margin, and the zoom in bounds (3 decimals)", () => {
    expect(clampViewportView(10.4, 20.6, 1)).toEqual({ x: 10, y: 21, zoom: 1 });
    expect(clampViewportView(LO - 50, HI_Y + 50, 5)).toEqual({ x: LO, y: HI_Y, zoom: MAX_ZOOM });
    expect(clampViewportView(0, 0, 0.123456)).toEqual({ x: 0, y: 0, zoom: 0.123 });
    expect(clampViewportView(0, 0, 0.01)).toEqual({ x: 0, y: 0, zoom: MIN_ZOOM });
  });
});

describe("sizes", () => {
  it("the largest new messages are small", () => {
    const view = { x: -VIEWPORT_MARGIN, y: -VIEWPORT_MARGIN, zoom: 0.123 };
    const sizes = {
      viewportIn: utf8Length(encodeMessage({ type: "viewport", x: -VIEWPORT_MARGIN + 0.123456789, y: -VIEWPORT_MARGIN + 0.123456789, zoom: 0.123456789 })),
      viewportUpdate: utf8Length(encodeMessage({ type: "viewportUpdate", id: ID, ...view })),
      followersChanged: utf8Length(encodeMessage({ type: "followersChanged", count: MAX_FOLLOWERS })),
      followEnded: utf8Length(encodeMessage({ type: "followEnded", reason: "target_left" })),
      broughtToMe: utf8Length(encodeMessage({ type: "broughtToMe", from: ID, ...view })),
    };
    for (const n of Object.values(sizes)) expect(n).toBeLessThan(128);
    // Recorded in docs/LIMITS.md.
    expect(sizes).toEqual({ viewportIn: 87, viewportUpdate: 73, followersChanged: 37, followEnded: 41, broughtToMe: 72 });
  });
});
