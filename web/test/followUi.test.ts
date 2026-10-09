// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_FOLLOWERS } from "@stickyard/shared";
import { VIEW_ANIMATION_MS } from "../src/canvas/navigation";
import {
  BRING_COOLDOWN_MS,
  BRING_TEXT,
  BROUGHT_BANNER_MS,
  FOLLOW_STREAM_MS,
  FOLLOW_TEXT,
  MoveGuard,
  bringReason,
  followDuration,
  followEndText,
  followReason,
} from "../src/follow/followUi";
import { bringSent, dismissBrought, followSink, followStarted, followStopped, useFollow } from "../src/follow/followStore";

/*
 * Follow and Bring to me, part 2 (the UI): the pure texts and rules, the guard that tells my own
 * pans and zooms from the page's, and what the store keeps for the chip, the notices, the
 * announcer and the banner. Names are already truncated by the callers.
 */

describe("texts", () => {
  it("say who, plainly", () => {
    expect(FOLLOW_TEXT.following("Sam")).toBe("Following Sam");
    expect(FOLLOW_TEXT.waiting("Sam")).toBe("Waiting for Sam’s view.");
    expect(FOLLOW_TEXT.stopped("Sam")).toBe("Stopped following Sam.");
    expect(FOLLOW_TEXT.followers(3)).toBe("3 following you");
    expect(BRING_TEXT.sent).toBe("Asked everyone to come to your view.");
    expect(BRING_TEXT.cooldown).toBe("Wait a few seconds.");
    expect(BRING_TEXT.banner("Jo")).toBe("Jo asked everyone to come to their view");
  });

  it("followEnded reasons and a refused follow", () => {
    expect(followEndText("target_left", "Sam")).toBe("Sam left.");
    expect(followEndText("not_found", "Sam")).toBe("That person isn’t here.");
    expect(followEndText("followers_full", "Sam")).toBe(`Sam already has ${MAX_FOLLOWERS} people following.`);
    expect(followEndText("followers_full", "Sam")).toBe("Sam already has 10 people following.");
    expect(followEndText("self", null)).toBe("You can’t follow yourself.");
    // No name known any more: never an empty sentence.
    expect(followEndText("target_left", null)).toBe("That person left.");
  });
});

describe("reasons", () => {
  it("Follow is off only while not connected", () => {
    expect(followReason({ live: true })).toBeNull();
    expect(followReason({ live: false })).toBe("Not connected.");
  });

  it(`Bring to me is off while not connected and for ${BRING_COOLDOWN_MS} ms after one is sent`, () => {
    expect(BRING_COOLDOWN_MS).toBe(5000);
    expect(bringReason({ live: true, now: 1000, sentAt: null })).toBeNull();
    expect(bringReason({ live: false, now: 1000, sentAt: null })).toBe("Not connected.");
    expect(bringReason({ live: true, now: 1000, sentAt: 1000 })).toBe("Wait a few seconds.");
    expect(bringReason({ live: true, now: 1000 + BRING_COOLDOWN_MS - 1, sentAt: 1000 })).toBe("Wait a few seconds.");
    expect(bringReason({ live: true, now: 1000 + BRING_COOLDOWN_MS, sentAt: 1000 })).toBeNull();
  });

  it("the banner goes after a minute", () => {
    expect(BROUGHT_BANNER_MS).toBe(60_000);
  });
});

describe("followDuration", () => {
  it("animates the first move, sets a stream of updates directly, never animates with reduced motion", () => {
    expect(followDuration({ now: 5000, last: null, reduced: false })).toBe(VIEW_ANIMATION_MS);
    expect(followDuration({ now: 5000, last: 5000 - 200, reduced: false })).toBe(0);
    expect(followDuration({ now: 5000, last: 5000 - FOLLOW_STREAM_MS, reduced: false })).toBe(VIEW_ANIMATION_MS);
    expect(followDuration({ now: 5000, last: null, reduced: true })).toBe(0);
  });
});

describe("MoveGuard: programmatic moves versus mine", () => {
  const input = new Event("wheel");

  it("a move with an input event is mine; one without is the page's", () => {
    const g = new MoveGuard();
    expect(g.userMove(input)).toBe(true);
    expect(g.userMove(null)).toBe(false);
    expect(g.userMove(undefined)).toBe(false);
  });

  it("inside programmatic(), nothing counts as mine, even with an input event", () => {
    const g = new MoveGuard();
    const seen: boolean[] = [];
    g.programmatic(() => {
      seen.push(g.active, g.userMove(input));
      // Nested (Go there while a follow move runs).
      g.programmatic(() => seen.push(g.userMove(input)));
      seen.push(g.userMove(input));
    });
    expect(seen).toEqual([true, false, false, false]);
    expect(g.active).toBe(false);
    expect(g.userMove(input)).toBe(true);
  });

  it("returns the move's result, and a move that throws still lowers the flag", () => {
    const g = new MoveGuard();
    expect(g.programmatic(() => 7)).toBe(7);
    expect(() =>
      g.programmatic(() => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(g.active).toBe(false);
    expect(g.userMove(input)).toBe(true);
  });
});

describe("followStore: the UI's part", () => {
  afterEach(() => {
    followSink.clear();
    useFollow.setState({ bringSentAt: null });
  });

  const sam = "BBBBBBBBBBBBBBBB";

  it("a start keeps the name and announces it once", () => {
    followSink.following(sam);
    followStarted("Sam");
    const s = useFollow.getState();
    expect(s.leaderName).toBe("Sam");
    expect(s.announce?.text).toBe("Following Sam. Pan or zoom to stop.");
    expect(s.notice).toBeNull();
  });

  it("a stop (Stop, my own pan or zoom, Go there) says so once, plainly and to screen readers", () => {
    followSink.following(sam);
    followStarted("Sam");
    followSink.following(null);
    followStopped();
    const s = useFollow.getState();
    expect(s.notice?.text).toBe("Stopped following Sam.");
    expect(s.announce?.text).toBe("Stopped following Sam.");
    expect(s.leaderName).toBeNull();
    // Nothing to stop: nothing said.
    const n = s.announce?.n;
    followStopped();
    expect(useFollow.getState().announce?.n).toBe(n);
  });

  it("followEnded and followers_full: the notice by reason, not following any more", () => {
    followSink.following(sam);
    followStarted("Sam");
    followSink.ended("target_left");
    expect(useFollow.getState()).toMatchObject({ following: null, leaderName: null, notice: { text: "Sam left." }, announce: { text: "Sam left." } });
    followSink.following(sam);
    followStarted("Sam");
    followSink.ended("followers_full");
    expect(useFollow.getState().notice?.text).toBe("Sam already has 10 people following.");
    followSink.following(sam);
    followStarted("Sam");
    followSink.ended("not_found");
    expect(useFollow.getState().notice?.text).toBe("That person isn’t here.");
  });

  it("a new follow replaces the name; the old one's notice goes", () => {
    followSink.following(sam);
    followStarted("Sam");
    followSink.ended("not_found");
    followSink.following("CCCCCCCCCCCCCCCC");
    followStarted("Jo");
    expect(useFollow.getState()).toMatchObject({ leaderName: "Jo", notice: null });
  });

  it("Bring to me: the time it was sent and one announcement; dismissing a banner keeps its seq", () => {
    bringSent(1234);
    expect(useFollow.getState().bringSentAt).toBe(1234);
    expect(useFollow.getState().announce?.text).toBe("Asked everyone to come to your view.");
    followSink.brought({ from: sam, x: 1, y: 2, zoom: 1 });
    const seq = useFollow.getState().brought!.seq;
    dismissBrought();
    expect(useFollow.getState().dismissed).toBe(seq);
    // A newer one isn't dismissed.
    followSink.brought({ from: sam, x: 1, y: 2, zoom: 1 });
    expect(useFollow.getState().brought!.seq).toBeGreaterThan(useFollow.getState().dismissed);
  });

  it("clear() (join, drop, resync, leave, End session) empties the UI's part too, but keeps the Bring to me cooldown", () => {
    followSink.following(sam);
    followStarted("Sam");
    followSink.ended("target_left");
    followSink.brought({ from: sam, x: 1, y: 2, zoom: 1 });
    bringSent(99);
    followSink.clear();
    expect(useFollow.getState()).toMatchObject({ following: null, leaderName: null, notice: null, announce: null, brought: null, dismissed: 0, bringSentAt: 99 });
  });

  it("never touches browser storage", () => {
    const get = vi.spyOn(Storage.prototype, "getItem");
    const set = vi.spyOn(Storage.prototype, "setItem");
    followSink.following(sam);
    followStarted("Sam");
    followStopped();
    bringSent(1);
    followSink.brought({ from: sam, x: 1, y: 2, zoom: 1 });
    dismissBrought();
    followSink.clear();
    expect(get).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });
});
