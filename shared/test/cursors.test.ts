import { describe, expect, it } from "vitest";
import {
  BOARD_HEIGHT,
  BOARD_WIDTH,
  BOARD_WRITES,
  CURSOR_TOLERANCE,
  HOST_ONLY,
  MAX_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  clampCursor,
  clientMessageSchema,
  encodeMessage,
  serverMessageSchema,
  utf8Length,
} from "../src";

/* Protocol v14 (live cursors): cursor / cursorLeft from a page, cursorMoved / cursorGone from the relay. */

const ID = "AAAAAAAAAAAAAAAA";
const ok = (m: unknown) => clientMessageSchema.safeParse(m).success;
const serverOk = (m: unknown) => serverMessageSchema.safeParse(m).success;

describe("protocol v14", () => {
  it("is version 14", () => {
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(14);
  });

  it("cursor messages never change the board and aren't host-only (a locked board still shows cursors)", () => {
    expect(BOARD_WRITES.cursor).toBe(false);
    expect(BOARD_WRITES.cursorLeft).toBe(false);
    expect(HOST_ONLY).not.toContain("cursor");
    expect(HOST_ONLY).not.toContain("cursorLeft");
  });

  it("cursor: finite numbers within the board plus a small tolerance, strict", () => {
    expect(CURSOR_TOLERANCE).toBeGreaterThan(0);
    expect(CURSOR_TOLERANCE).toBeLessThanOrEqual(100);
    expect(ok({ type: "cursor", x: 0, y: 0 })).toBe(true);
    expect(ok({ type: "cursor", x: 12.5, y: 99.25 })).toBe(true);
    expect(ok({ type: "cursor", x: BOARD_WIDTH, y: BOARD_HEIGHT })).toBe(true);
    expect(ok({ type: "cursor", x: -CURSOR_TOLERANCE, y: BOARD_HEIGHT + CURSOR_TOLERANCE })).toBe(true);
    expect(ok({ type: "cursor", x: -CURSOR_TOLERANCE - 1, y: 0 })).toBe(false);
    expect(ok({ type: "cursor", x: 0, y: BOARD_HEIGHT + CURSOR_TOLERANCE + 1 })).toBe(false);
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, "10", null, undefined]) {
      expect(ok({ type: "cursor", x: bad, y: 10 })).toBe(false);
      expect(ok({ type: "cursor", x: 10, y: bad })).toBe(false);
    }
    // Nothing a page sends can name a participant, a name or a colour.
    expect(ok({ type: "cursor", x: 1, y: 1, id: ID })).toBe(false);
    expect(ok({ type: "cursor", x: 1, y: 1, name: "Sam" })).toBe(false);
    expect(ok({ type: "cursor", x: 1, y: 1, colourIndex: 2 })).toBe(false);
  });

  it("cursorLeft: no fields at all", () => {
    expect(ok({ type: "cursorLeft" })).toBe(true);
    expect(ok({ type: "cursorLeft", id: ID })).toBe(false);
    expect(ok({ type: "cursorLeft", x: 1 })).toBe(false);
  });

  it("cursorMoved and cursorGone: a participant id and whole board units, strict", () => {
    expect(serverOk({ type: "cursorMoved", id: ID, x: 0, y: 0 })).toBe(true);
    expect(serverOk({ type: "cursorMoved", id: ID, x: BOARD_WIDTH, y: BOARD_HEIGHT })).toBe(true);
    expect(serverOk({ type: "cursorMoved", id: ID, x: -1, y: 0 })).toBe(false);
    expect(serverOk({ type: "cursorMoved", id: ID, x: 1.5, y: 0 })).toBe(false);
    expect(serverOk({ type: "cursorMoved", id: ID, x: BOARD_WIDTH + 1, y: 0 })).toBe(false);
    expect(serverOk({ type: "cursorMoved", id: "short", x: 1, y: 1 })).toBe(false);
    expect(serverOk({ type: "cursorMoved", id: ID, x: 1, y: 1, name: "Sam" })).toBe(false);
    expect(serverOk({ type: "cursorGone", id: ID })).toBe(true);
    expect(serverOk({ type: "cursorGone", id: ID, x: 1 })).toBe(false);
  });

  it("clampCursor rounds to whole units and clamps to the board", () => {
    expect(clampCursor(10.4, 20.6)).toEqual({ x: 10, y: 21 });
    expect(clampCursor(-40, BOARD_HEIGHT + 40)).toEqual({ x: 0, y: BOARD_HEIGHT });
    expect(clampCursor(BOARD_WIDTH + 1, -0.4)).toEqual({ x: BOARD_WIDTH, y: 0 });
  });

  it("the messages are tiny: a cursorMoved is a few dozen bytes", () => {
    const moved = encodeMessage({ type: "cursorMoved", id: ID, x: BOARD_WIDTH, y: BOARD_HEIGHT });
    expect(utf8Length(moved)).toBeLessThanOrEqual(64);
    expect(utf8Length(JSON.stringify({ type: "cursor", x: -CURSOR_TOLERANCE + 0.123456789, y: BOARD_HEIGHT }))).toBeLessThan(MAX_MESSAGE_BYTES);
  });
});
