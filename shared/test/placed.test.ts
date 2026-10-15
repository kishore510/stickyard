import { describe, expect, it } from "vitest";
import { FRAME_DEFAULTS, NOTE_DEFAULTS, PROTOCOL_VERSION, clientMessageSchema, noteItemSchema, placedSchema, serverMessageSchema, shapeDefaults } from "../src";

/*
 * Protocol v23 (frame membership): notes, shapes and frames carry `placed`, the relay's per-room
 * placement counter, and final noteMoved, shapeMoved and frameMoved give the new value. Only the
 * relay sets it: no client message carries it. Generic fixtures.
 */

const ID = "AAAAAAAAAAAAAAAA";
const serverOk = (m: unknown) => serverMessageSchema.safeParse(m).success;
const clientOk = (m: unknown) => clientMessageSchema.safeParse(m).success;
const note = (extra: Record<string, unknown> = {}) => ({ id: ID, x: 10, y: 10, ...NOTE_DEFAULTS, text: "", color: "yellow", z: 0, rev: 1, authorId: ID, ...extra });
const frame = (extra: Record<string, unknown> = {}) => ({ id: ID, x: 0, y: 0, w: 640, h: 400, title: "", color: "neutral", ...FRAME_DEFAULTS, rev: 1, authorId: ID, ...extra });
const shape = (extra: Record<string, unknown> = {}) => ({ id: ID, kind: "rect", x: 0, y: 0, ...shapeDefaults("rect"), text: "", z: 0, rev: 1, authorId: ID, ...extra });

describe("protocol v23", () => {
  it("is version 23 or later", () => {
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(23);
  });

  it("placed is a whole number from 0 to MAX_SAFE_INTEGER", () => {
    for (const ok of [0, 1, Number.MAX_SAFE_INTEGER]) expect(placedSchema.safeParse(ok).success).toBe(true);
    for (const bad of [-1, 1.5, Number.MAX_SAFE_INTEGER + 2, "3", null]) expect(placedSchema.safeParse(bad).success).toBe(false);
  });

  it("notes, frames and shapes may carry it (absent is 0: placed before v23)", () => {
    expect(serverOk({ type: "noteAdded", note: note({ placed: 7 }) })).toBe(true);
    expect(serverOk({ type: "noteAdded", note: note() })).toBe(true);
    expect(serverOk({ type: "frameAdded", frame: frame({ placed: 7 }) })).toBe(true);
    expect(serverOk({ type: "shapeAdded", shape: shape({ placed: 7 }) })).toBe(true);
    expect(serverOk({ type: "noteAdded", note: note({ placed: -1 }) })).toBe(false);
    expect(serverOk({ type: "framesSnapshot", frames: [frame({ placed: 1.5 })] })).toBe(false);
  });

  it("final noteMoved, shapeMoved, frameMoved and batch results may give it", () => {
    expect(serverOk({ type: "noteMoved", id: ID, x: 1, y: 2, rev: 2, final: true, placed: 3 })).toBe(true);
    expect(serverOk({ type: "shapeMoved", id: ID, x: 1, y: 2, rev: 2, final: true, placed: 3 })).toBe(true);
    expect(serverOk({ type: "frameMoved", id: ID, x: 1, y: 2, rev: 2, final: true, placed: 3, notes: [{ id: ID, x: 5, y: 5, rev: 2 }] })).toBe(true);
    expect(serverOk({ type: "notesBatchApplied", final: true, results: [{ type: "noteMoved", id: ID, x: 1, y: 2, rev: 2, final: true, placed: 3 }] })).toBe(true);
    expect(serverOk({ type: "noteMoved", id: ID, x: 1, y: 2, rev: 2, final: true, placed: -3 })).toBe(false);
  });

  it("no client message may carry it: the relay sets it (strict schemas refuse it)", () => {
    const { w, h, ...style } = NOTE_DEFAULTS;
    const item = { ref: "r1", x: 0, y: 0, w, h, text: "", color: "yellow", ...style };
    // itemsAdd entries are checked one by one (checkItems): an entry with placed is refused as invalid.
    expect(noteItemSchema.safeParse(item).success).toBe(true);
    expect(noteItemSchema.safeParse({ ...item, placed: 1 }).success).toBe(false);
    expect(clientOk({ type: "noteMove", id: ID, x: 1, y: 1, final: true, placed: 1 })).toBe(false);
    expect(clientOk({ type: "frameMove", id: ID, x: 1, y: 1, final: true, placed: 1 })).toBe(false);
  });
});
