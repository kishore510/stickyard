// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CURSOR_IDLE_MS, forgetPosition, rememberPosition } from "../src/cursors/cursors";
import { cursorSink, useCursors } from "../src/cursors/cursorStore";
import { useCursorPrefs } from "../src/cursors/prefs";
import { JUMP_HINT } from "../src/canvas/navigation";
import { room, sam } from "./helpers/fakeRelay";

/*
 * Jump to a person (v0.24.0): each other person's last known pointer position, kept in memory
 * apart from the cursor layer. It survives the fade and cursorGone, and goes when they leave or
 * on a reconnect. Never written to browser storage.
 */

const joined = () =>
  room([], [], { cursors: cursorSink }, (relay) => {
    relay.others = [sam];
  });

beforeEach(() => {
  vi.useFakeTimers();
  useCursors.getState().clear();
});
afterEach(() => {
  useCursors.getState().clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const last = (id: string) => useCursors.getState().lastSeen.get(id);

describe("pure helpers", () => {
  it("remember keeps the same map when nothing changed; forget removes", () => {
    const a = rememberPosition(new Map(), "A", 1, 2);
    expect(rememberPosition(a, "A", 1, 2)).toBe(a);
    expect(rememberPosition(a, "A", 3, 4).get("A")).toEqual({ x: 3, y: 4 });
    expect(forgetPosition(a, "B")).toBe(a);
    expect(forgetPosition(a, "A").size).toBe(0);
  });
});

describe("last known position", () => {
  it("is unknown until a pointer is seen (the Go to reason)", () => {
    joined();
    expect(last(sam.id)).toBeUndefined();
    expect(JUMP_HINT).toBe("No pointer position seen yet.");
  });

  it("survives the cursor's fade and cursorGone", async () => {
    const { relay } = joined();
    relay.emit({ type: "cursorMoved", id: sam.id, x: 1200, y: 800 });
    expect(last(sam.id)).toEqual({ x: 1200, y: 800 });
    await vi.advanceTimersByTimeAsync(CURSOR_IDLE_MS + 100);
    expect(useCursors.getState().cursors.get(sam.id)?.idle).toBe(true);
    expect(last(sam.id)).toEqual({ x: 1200, y: 800 });
    relay.emit({ type: "cursorGone", id: sam.id });
    expect(useCursors.getState().cursors.has(sam.id)).toBe(false);
    expect(last(sam.id)).toEqual({ x: 1200, y: 800 });
  });

  it("follows the latest move", () => {
    const { relay } = joined();
    relay.emit({ type: "cursorMoved", id: sam.id, x: 10, y: 20 });
    relay.emit({ type: "cursorMoved", id: sam.id, x: 30, y: 40 });
    expect(last(sam.id)).toEqual({ x: 30, y: 40 });
  });

  it("is cleared when that person leaves", () => {
    const { relay } = joined();
    relay.emit({ type: "cursorMoved", id: sam.id, x: 10, y: 20 });
    relay.leave(sam.id);
    expect(last(sam.id)).toBeUndefined();
  });

  it("is cleared on a reconnect", async () => {
    const { relay } = joined();
    relay.emit({ type: "cursorMoved", id: sam.id, x: 10, y: 20 });
    relay.drop();
    await vi.advanceTimersByTimeAsync(1500);
    relay.open();
    expect(last(sam.id)).toBeUndefined();
    expect(useCursors.getState().lastSeen.size).toBe(0);
  });

  it("is tracked with Show other people's cursors switched off", () => {
    useCursorPrefs.setState({ show: false });
    const { relay } = joined();
    relay.emit({ type: "cursorMoved", id: sam.id, x: 50, y: 60 });
    expect(last(sam.id)).toEqual({ x: 50, y: 60 });
    useCursorPrefs.setState({ show: true });
  });

  it("is never written to browser storage", async () => {
    const local = vi.spyOn(Storage.prototype, "setItem");
    const { relay } = joined();
    local.mockClear();
    relay.emit({ type: "cursorMoved", id: sam.id, x: 10, y: 20 });
    relay.emit({ type: "cursorGone", id: sam.id });
    await vi.advanceTimersByTimeAsync(CURSOR_IDLE_MS + 100);
    relay.leave(sam.id);
    expect(local).not.toHaveBeenCalled();
  });
});
