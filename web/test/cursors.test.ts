// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BOARD_HEIGHT, BOARD_WIDTH, FRAME_COLORS, NOTE_COLORS, PALETTE_SIZE } from "@stickyard/shared";
import {
  CURSOR_IDLE_MS,
  CURSOR_LABEL_CHARS,
  CURSOR_MIN_MOVE,
  CURSOR_SEND_INTERVAL_MS,
  CursorSender,
  cursorDecision,
  cursorLabel,
  idleCursors,
  moveCursor,
  nextIdleAt,
  onBoardPoint,
  placeCursor,
  pointerMaySend,
  removeCursor,
  type RemoteCursors,
} from "../src/cursors/cursors";
import { readCursorPrefs, writeCursorPref } from "../src/cursors/prefs";
import { useCursors } from "../src/cursors/cursorStore";
import { STORAGE_KEYS } from "../src/storage";

/* Live cursors (v0.19.0): the pure rules for sending, keeping and placing other people's pointers. */

describe("sending: throttle and movement threshold", () => {
  it("sends at most every 100 ms and only after a move of at least 1 board unit", () => {
    expect(CURSOR_SEND_INTERVAL_MS).toBe(100);
    expect(CURSOR_MIN_MOVE).toBe(1);
    expect(cursorDecision(null, 10, 10, 0)).toEqual({ kind: "send" });
    const last = { at: 1000, x: 10, y: 10 };
    expect(cursorDecision(last, 10.5, 10.9, 2000)).toEqual({ kind: "skip" });
    expect(cursorDecision(last, 11, 10, 1040)).toEqual({ kind: "wait", ms: 60 });
    expect(cursorDecision(last, 11, 10, 1100)).toEqual({ kind: "send" });
    expect(cursorDecision(last, 10, 8.5, 1500)).toEqual({ kind: "send" });
  });

  it("CursorSender: leading send, one trailing send with the latest position, leave resets", () => {
    let now = 0;
    const timers: { at: number; fn: () => void }[] = [];
    const sent: unknown[] = [];
    const sender = new CursorSender({
      now: () => now,
      setTimer: (fn, ms) => {
        timers.push({ at: now + ms, fn });
        return timers.length;
      },
      clearTimer: (id) => {
        if (typeof id === "number") timers[id - 1] = { at: Infinity, fn: () => {} };
      },
      send: (x, y) => {
        sent.push(["cursor", x, y]);
        return true;
      },
      leave: () => sent.push(["leave"]),
    });
    sender.move(10, 10);
    now = 20;
    sender.move(20, 20);
    now = 50;
    sender.move(30, 30);
    expect(sent).toEqual([["cursor", 10, 10]]);
    // The trailing send at 100 ms carries the latest position, once.
    now = 100;
    for (const t of timers.splice(0)) if (t.at <= now) t.fn();
    expect(sent).toEqual([["cursor", 10, 10], ["cursor", 30, 30]]);
    // Not moved: nothing.
    now = 400;
    sender.move(30.4, 30);
    expect(sent).toHaveLength(2);
    sender.leave();
    expect(sent.at(-1)).toEqual(["leave"]);
    // Back on the board: sent at once (no wait after a leave).
    now = 410;
    sender.move(30, 30);
    expect(sent.at(-1)).toEqual(["cursor", 30, 30]);
  });

  it("a send the session refuses (nobody else here, hidden, offline) doesn't count as sent", () => {
    let allowed = false;
    const sent: number[] = [];
    let now = 0;
    const sender = new CursorSender({
      now: () => now,
      setTimer: () => 1,
      clearTimer: () => {},
      send: (x) => {
        if (allowed) sent.push(x);
        return allowed;
      },
      leave: () => {},
    });
    sender.move(5, 5);
    allowed = true;
    now = 10;
    sender.move(5, 5);
    expect(sent).toEqual([5]);
  });

  it("only a mouse, or a pen hovering, may send: never touch, never a pen pressing (a tap)", () => {
    expect(pointerMaySend({ pointerType: "mouse", buttons: 0 })).toBe(true);
    expect(pointerMaySend({ pointerType: "mouse", buttons: 1 })).toBe(true);
    expect(pointerMaySend({ pointerType: "", buttons: 0 })).toBe(true);
    expect(pointerMaySend({ pointerType: "pen", buttons: 0 })).toBe(true);
    expect(pointerMaySend({ pointerType: "pen", buttons: 1 })).toBe(false);
    expect(pointerMaySend({ pointerType: "touch", buttons: 0 })).toBe(false);
    expect(pointerMaySend({ pointerType: "touch", buttons: 1 })).toBe(false);
  });

  it("the board area is the board itself: off it, the cursor leaves", () => {
    expect(onBoardPoint(0, 0)).toBe(true);
    expect(onBoardPoint(BOARD_WIDTH, BOARD_HEIGHT)).toBe(true);
    expect(onBoardPoint(-1, 10)).toBe(false);
    expect(onBoardPoint(10, BOARD_HEIGHT + 1)).toBe(false);
    expect(onBoardPoint(Number.NaN, 0)).toBe(false);
  });
});

describe("receiving: the cursor map", () => {
  it("moves, idles after 5 s without movement, wakes on the next move, and is removed", () => {
    expect(CURSOR_IDLE_MS).toBe(5000);
    let map: RemoteCursors = new Map();
    map = moveCursor(map, "A", 10, 20, 1000);
    map = moveCursor(map, "B", 30, 40, 3000);
    expect(nextIdleAt(map)).toBe(6000);
    expect(idleCursors(map, 5999)).toBe(map);
    map = idleCursors(map, 6000);
    expect(map.get("A")).toMatchObject({ idle: true });
    expect(map.get("B")).toMatchObject({ idle: false });
    expect(nextIdleAt(map)).toBe(8000);
    map = moveCursor(map, "A", 11, 20, 7000);
    expect(map.get("A")).toEqual({ x: 11, y: 20, at: 7000, idle: false });
    map = removeCursor(map, "A");
    expect([...map.keys()]).toEqual(["B"]);
    expect(removeCursor(map, "nobody")).toBe(map);
  });

  describe("store", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      useCursors.getState().clear();
    });
    afterEach(() => {
      useCursors.getState().clear();
      vi.useRealTimers();
    });

    it("hides a cursor 5 s after it last moved (one timer, not a tick), removes on gone, clears all", () => {
      const s = () => useCursors.getState();
      s().moved("A", 1, 2);
      vi.advanceTimersByTime(3000);
      s().moved("B", 3, 4);
      vi.advanceTimersByTime(2000);
      expect(s().cursors.get("A")?.idle).toBe(true);
      expect(s().cursors.get("B")?.idle).toBe(false);
      expect(vi.getTimerCount()).toBe(1);
      vi.advanceTimersByTime(3000);
      expect(s().cursors.get("B")?.idle).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      s().gone("A");
      expect(s().cursors.has("A")).toBe(false);
      s().clear();
      expect(s().cursors.size).toBe(0);
    });
  });
});

describe("drawing: placement, counter-scale and labels", () => {
  const view = { x: 100, y: 100, width: 800, height: 600 };
  const reserve = { arrow: 20, label: 120 };

  it("keeps a constant screen size: the mark is scaled by 1 / zoom", () => {
    expect(placeCursor({ x: 300, y: 300 }, view, 2, reserve).scale).toBe(0.5);
    expect(placeCursor({ x: 300, y: 300 }, view, 0.25, reserve).scale).toBe(4);
  });

  it("stays within the visible board area, and flips its label near the right edge", () => {
    expect(placeCursor({ x: 300, y: 300 }, view, 1, reserve)).toEqual({ x: 300, y: 300, scale: 1, flip: false });
    expect(placeCursor({ x: 0, y: 0 }, view, 1, reserve)).toMatchObject({ x: 100, y: 100 });
    const right = placeCursor({ x: 2000, y: 2000 }, view, 1, reserve);
    expect(right.x).toBe(900 - 20);
    expect(right.y).toBe(700 - 20);
    expect(right.flip).toBe(true);
    // At zoom 2 the reserve is half as many board units.
    expect(placeCursor({ x: 2000, y: 300 }, view, 2, reserve).x).toBe(900 - 10);
  });

  it("labels are plain text, truncated to the token's length", () => {
    expect(CURSOR_LABEL_CHARS).toBe(12);
    expect(cursorLabel("Sam")).toBe("Sam");
    expect(cursorLabel("Alexandra-Maria Smith")).toBe("Alexandra-M…");
    expect(Array.from(cursorLabel("😀".repeat(20)))).toHaveLength(12);
    expect(cursorLabel("<b>hi</b>")).toBe("<b>hi</b>");
  });
});

describe("preferences", () => {
  beforeEach(() => localStorage.clear());

  it("both switches default on; stored under stickyard: keys only when changed", () => {
    expect(readCursorPrefs()).toEqual({ show: true, share: true });
    expect(localStorage.length).toBe(0);
    writeCursorPref("show", false);
    expect(localStorage.getItem(STORAGE_KEYS.showCursors)).toBe("off");
    writeCursorPref("share", false);
    expect(localStorage.getItem(STORAGE_KEYS.shareCursor)).toBe("off");
    expect(readCursorPrefs()).toEqual({ show: false, share: false });
    writeCursorPref("show", true);
    expect(readCursorPrefs()).toEqual({ show: true, share: false });
    expect(STORAGE_KEYS.showCursors.startsWith("stickyard:")).toBe(true);
    expect(STORAGE_KEYS.shareCursor.startsWith("stickyard:")).toBe(true);
  });

  it("never throws when storage is blocked", () => {
    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readCursorPrefs(blocked)).toEqual({ show: true, share: true });
    expect(writeCursorPref("show", false, blocked)).toBe(false);
  });
});

/* Tokens: sizes and timings in tokens.css; the cursor readable on every note and frame colour, both themes. */

const tokens = readFileSync(join(process.cwd(), "src/styles/tokens.css"), "utf8");
function theme(selector: string): Record<string, string> {
  const start = tokens.indexOf(selector);
  const block = tokens.slice(start, tokens.indexOf("}", start));
  return Object.fromEntries([...block.matchAll(/--sy-([\w-]+):\s*(#[0-9a-f]{6})\b/g)].map((m) => [m[1], m[2]]));
}
const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
};
const THEMES = [':root,\n[data-theme="light"]', '[data-theme="dark"]'];

describe("cursor tokens", () => {
  it("sizes, the label length, and motion that is 0 under reduced motion", () => {
    for (const name of ["--sy-cursor-size", "--sy-cursor-size-sm", "--sy-cursor-label-max", "--sy-duration-cursor", "--sy-cursor-fade"]) expect(tokens).toMatch(new RegExp(`${name}:`));
    expect(tokens).toContain(`--sy-cursor-label-max: ${CURSOR_LABEL_CHARS}ch;`);
    const reduced = tokens.slice(tokens.indexOf("@media (prefers-reduced-motion: reduce)"));
    const block = reduced.slice(0, reduced.indexOf("}\n}") + 3);
    expect(block).toMatch(/--sy-duration-cursor:\s*0ms/);
    expect(block).toMatch(/--sy-cursor-fade:\s*0ms/);
  });

  it.each(THEMES)("in %s the outline pair reads on every note colour, frame header, the board and the canvas", (selector) => {
    const c = theme(selector);
    const outline = c["cursor-outline"]!;
    const halo = c["cursor-halo"]!;
    expect(outline).toBeDefined();
    expect(halo).toBeDefined();
    // The two edges are distinct from each other...
    expect(contrast(outline, halo)).toBeGreaterThanOrEqual(3);
    // ...so on any surface at least one of them is a 3:1 edge (WCAG 1.4.11).
    const surfaces = [...NOTE_COLORS.map((n) => `note-${n}`), ...FRAME_COLORS.map((f) => `frame-${f}-header`), "board", "canvas", "bg", "surface"];
    for (const s of surfaces) {
      expect(c[s], s).toBeDefined();
      expect(Math.max(contrast(outline, c[s]!), contrast(halo, c[s]!)), `cursor edge on ${s}`).toBeGreaterThanOrEqual(3);
    }
  });

  it.each(THEMES)("in %s the label text is 4.5:1 on every participant colour", (selector) => {
    const c = theme(selector);
    const fg = c["cursor-label-fg"]!;
    expect(fg).toBeDefined();
    for (let i = 1; i <= PALETTE_SIZE; i++) expect(contrast(fg, c[`participant-${i}`]!), `label on participant-${i}`).toBeGreaterThanOrEqual(4.5);
  });
});
