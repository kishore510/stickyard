// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_ZOOM, MIN_ZOOM } from "@stickyard/shared";
import * as geometry from "../src/canvas/geometry";
import { FOLLOW_SEND_INTERVAL_MS, ViewportSender, isUserMove, mayShareViewport, viewChanged, viewFromCentre } from "../src/follow/follow";
import { followSink, useFollow } from "../src/follow/followStore";

/*
 * Follow and Bring to me, part 1 (web plumbing, no visible UI): the pure send rules and the
 * store. A viewport on the wire is the board point at the centre of my view, and my zoom.
 */

describe("shared zoom bounds", () => {
  it("the canvas uses the shared MIN_ZOOM and MAX_ZOOM", () => {
    expect(geometry.MIN_ZOOM).toBe(MIN_ZOOM);
    expect(geometry.MAX_ZOOM).toBe(MAX_ZOOM);
  });
});

describe("viewFromCentre", () => {
  it("is the board point at the centre of the canvas, whole units, zoom to 3 decimals", () => {
    // screen = flow * zoom + offset: at zoom 0.5 with offset (100, 50), the centre of 800 x 600 is ((400-100)/0.5, (300-50)/0.5).
    expect(viewFromCentre({ x: 100, y: 50, zoom: 0.5 }, { width: 800, height: 600 })).toEqual({ x: 600, y: 500, zoom: 0.5 });
    expect(viewFromCentre({ x: 0, y: 0, zoom: 0.33333 }, { width: 2, height: 2 })).toEqual({ x: 3, y: 3, zoom: 0.333 });
  });
});

describe("viewChanged", () => {
  it("anything at all the first time; then a move of at least 1 unit or a zoom change of 0.001", () => {
    const v = { x: 10, y: 10, zoom: 1 };
    expect(viewChanged(null, v)).toBe(true);
    expect(viewChanged(v, { ...v })).toBe(false);
    expect(viewChanged(v, { ...v, x: 10.4 })).toBe(false);
    expect(viewChanged(v, { ...v, x: 11 })).toBe(true);
    expect(viewChanged(v, { ...v, y: 9 })).toBe(true);
    expect(viewChanged(v, { ...v, zoom: 1.0004 })).toBe(false);
    expect(viewChanged(v, { ...v, zoom: 1.001 })).toBe(true);
  });
});

describe("mayShareViewport", () => {
  it("only live, with at least one follower, and never on a phone", () => {
    expect(mayShareViewport({ live: true, followers: 1, compact: false })).toBe(true);
    expect(mayShareViewport({ live: true, followers: 0, compact: false })).toBe(false);
    expect(mayShareViewport({ live: true, followers: 3, compact: true })).toBe(false);
    expect(mayShareViewport({ live: false, followers: 3, compact: false })).toBe(false);
  });
});

describe("isUserMove", () => {
  it("a move with an input event is the user's; one without (fit, jump, follow) is the page's own", () => {
    expect(isUserMove(new Event("wheel"))).toBe(true);
    expect(isUserMove(null)).toBe(false);
    expect(isUserMove(undefined)).toBe(false);
  });
});

describe("ViewportSender", () => {
  let now = 0;
  let timers: { at: number; fn: () => void; id: number }[] = [];
  let nextId = 1;
  const sent: { x: number; y: number; zoom: number }[] = [];
  let allow = true;
  const make = () =>
    new ViewportSender({
      now: () => now,
      setTimer: (fn, ms) => {
        const id = nextId++;
        timers.push({ at: now + ms, fn, id });
        return id;
      },
      clearTimer: (id) => {
        timers = timers.filter((t) => t.id !== id);
      },
      send: (v) => {
        if (!allow) return false;
        sent.push(v);
        return true;
      },
    });
  const advance = (ms: number) => {
    now += ms;
    for (const t of timers.filter((t) => t.at <= now)) {
      timers = timers.filter((x) => x !== t);
      t.fn();
    }
  };
  beforeEach(() => {
    now = 1_000;
    timers = [];
    sent.length = 0;
    allow = true;
  });

  it(`at most one send every ${FOLLOW_SEND_INTERVAL_MS} ms (5 a second): a leading send, then one trailing send with the latest view`, () => {
    expect(FOLLOW_SEND_INTERVAL_MS).toBe(200);
    const s = make();
    s.offer({ x: 0, y: 0, zoom: 1 });
    for (let i = 1; i <= 10; i++) {
      advance(10);
      s.offer({ x: i * 10, y: 0, zoom: 1 });
    }
    expect(sent).toEqual([{ x: 0, y: 0, zoom: 1 }]);
    advance(FOLLOW_SEND_INTERVAL_MS);
    expect(sent).toEqual([
      { x: 0, y: 0, zoom: 1 },
      { x: 100, y: 0, zoom: 1 },
    ]);
  });

  it("over a second of constant panning sends at most 5 or 6 (one leading, then one per interval)", () => {
    const s = make();
    for (let t = 0; t <= 1000; t += 16) {
      s.offer({ x: t, y: 0, zoom: 1 });
      advance(16);
    }
    advance(FOLLOW_SEND_INTERVAL_MS);
    expect(sent.length).toBeGreaterThanOrEqual(5);
    expect(sent.length).toBeLessThanOrEqual(7);
  });

  it("only when the view changed", () => {
    const s = make();
    s.offer({ x: 5, y: 5, zoom: 1 });
    advance(FOLLOW_SEND_INTERVAL_MS * 2);
    s.offer({ x: 5.2, y: 5, zoom: 1 });
    advance(FOLLOW_SEND_INTERVAL_MS * 2);
    expect(sent).toHaveLength(1);
  });

  it("force() sends the view now even if unchanged (a new follower needs it), still within the rate", () => {
    const s = make();
    s.offer({ x: 5, y: 5, zoom: 1 });
    advance(FOLLOW_SEND_INTERVAL_MS);
    s.force({ x: 5, y: 5, zoom: 1 });
    expect(sent).toHaveLength(2);
    s.force({ x: 5, y: 5, zoom: 1 });
    expect(sent).toHaveLength(2);
    advance(FOLLOW_SEND_INTERVAL_MS);
    expect(sent).toHaveLength(3);
  });

  it("a refused send doesn't count; reset() forgets the last view and any pending one", () => {
    const s = make();
    allow = false;
    s.offer({ x: 1, y: 1, zoom: 1 });
    allow = true;
    s.offer({ x: 1, y: 1, zoom: 1 });
    expect(sent).toHaveLength(1);
    advance(10);
    s.offer({ x: 50, y: 1, zoom: 1 });
    s.reset();
    advance(FOLLOW_SEND_INTERVAL_MS);
    expect(sent).toHaveLength(1);
    s.offer({ x: 1, y: 1, zoom: 1 });
    expect(sent).toHaveLength(2);
  });
});

describe("followStore", () => {
  afterEach(() => followSink.clear());

  it("keeps who I follow, my follower count, the leader's last view, the last end reason and the last bring", () => {
    followSink.following("BBBBBBBBBBBBBBBB");
    followSink.followers(2);
    followSink.viewport({ id: "BBBBBBBBBBBBBBBB", x: 1, y: 2, zoom: 1 });
    followSink.brought({ from: "CCCCCCCCCCCCCCCC", x: 3, y: 4, zoom: 0.5 });
    const s = useFollow.getState();
    expect(s.following).toBe("BBBBBBBBBBBBBBBB");
    expect(s.followers).toBe(2);
    expect(s.leader).toEqual({ id: "BBBBBBBBBBBBBBBB", x: 1, y: 2, zoom: 1 });
    expect(s.brought).toMatchObject({ from: "CCCCCCCCCCCCCCCC", x: 3, y: 4, zoom: 0.5 });
    followSink.ended("target_left");
    expect(useFollow.getState()).toMatchObject({ following: null, leader: null, ended: "target_left", followers: 2 });
  });

  it("each bring is a new one (a seq), even with the same numbers, so the page can act on a repeat", () => {
    followSink.brought({ from: "CCCCCCCCCCCCCCCC", x: 3, y: 4, zoom: 0.5 });
    const first = useFollow.getState().brought!.seq;
    followSink.brought({ from: "CCCCCCCCCCCCCCCC", x: 3, y: 4, zoom: 0.5 });
    expect(useFollow.getState().brought!.seq).toBeGreaterThan(first);
  });

  it("a new follow clears the last end reason and the old leader's view", () => {
    followSink.following("BBBBBBBBBBBBBBBB");
    followSink.viewport({ id: "BBBBBBBBBBBBBBBB", x: 1, y: 2, zoom: 1 });
    followSink.ended("not_found");
    followSink.following("CCCCCCCCCCCCCCCC");
    expect(useFollow.getState()).toMatchObject({ following: "CCCCCCCCCCCCCCCC", leader: null, ended: null });
  });

  it("clear() empties everything", () => {
    followSink.following("BBBBBBBBBBBBBBBB");
    followSink.followers(3);
    followSink.brought({ from: "CCCCCCCCCCCCCCCC", x: 3, y: 4, zoom: 0.5 });
    followSink.clear();
    expect(useFollow.getState()).toMatchObject({ following: null, followers: 0, leader: null, ended: null, brought: null });
  });

  it("never touches browser storage", () => {
    const get = vi.spyOn(Storage.prototype, "getItem");
    const set = vi.spyOn(Storage.prototype, "setItem");
    followSink.following("BBBBBBBBBBBBBBBB");
    followSink.followers(1);
    followSink.viewport({ id: "BBBBBBBBBBBBBBBB", x: 1, y: 2, zoom: 1 });
    followSink.brought({ from: "CCCCCCCCCCCCCCCC", x: 3, y: 4, zoom: 0.5 });
    followSink.ended("self");
    followSink.clear();
    expect(get).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
    get.mockRestore();
    set.mockRestore();
  });
});
