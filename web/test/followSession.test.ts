// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FollowSink } from "../src/follow/follow";
import { FOLLOW_SEND_INTERVAL_MS } from "../src/follow/follow";
import { alex, room, sam } from "./helpers/fakeRelay";

/*
 * Follow and Bring to me in the session (protocol v19, part 1: plumbing, no visible UI). What it
 * sends (followStart, followStop, viewport only while followed and never on a phone, bringToMe
 * only as host), what it does with viewportUpdate, followersChanged, followEnded and broughtToMe,
 * and that a new visit, a drop, a resync and leaving all forget following both ways.
 */

const JO = { id: "CCCCCCCCCCCCCCCC", name: "Jo", colourIndex: 2, host: false };

function sink() {
  const log: string[] = [];
  const s: FollowSink = {
    following: (id) => log.push(`following ${id}`),
    followers: (count) => log.push(`followers ${count}`),
    viewport: (v) => log.push(`viewport ${v.id} ${v.x},${v.y}@${v.zoom}`),
    ended: (reason) => log.push(`ended ${reason}`),
    brought: (b) => log.push(`brought ${b.from} ${b.x},${b.y}@${b.zoom}`),
    clear: () => log.push("clear"),
  };
  return { sink: s, log };
}

function joined(options: Parameters<typeof room>[2] = {}) {
  return room([], [], options, (relay) => {
    relay.others = [sam, JO];
  });
}

const view = (x: number, y = 0, zoom = 1) => ({ x, y, zoom });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("following someone", () => {
  it("startFollow sends followStart with their id and tells the sink; stopFollow sends followStop", () => {
    const s = sink();
    const { session, sent } = joined({ follow: s.sink });
    expect(session.startFollow(sam.id)).toBe(true);
    expect(sent("followStart")).toEqual([{ type: "followStart", target: sam.id }]);
    expect(s.log).toContain(`following ${sam.id}`);
    expect(session.stopFollow()).toBe(true);
    expect(sent("followStop")).toEqual([{ type: "followStop" }]);
    expect(s.log.at(-1)).toBe("following null");
    // Not following: nothing to stop.
    expect(session.stopFollow()).toBe(false);
    expect(sent("followStop")).toHaveLength(1);
  });

  it("never follows myself or someone not here; not while disconnected", () => {
    const { session, sent, relay } = joined();
    expect(session.startFollow(alex.id)).toBe(false);
    expect(session.startFollow("ZZZZZZZZZZZZZZZZ")).toBe(false);
    relay.drop();
    expect(session.startFollow(sam.id)).toBe(false);
    expect(sent("followStart")).toEqual([]);
  });

  it("following someone else replaces the follow (one followStart, the relay does the rest)", () => {
    const { session, sent } = joined();
    session.startFollow(sam.id);
    session.startFollow(JO.id);
    expect(sent("followStart")).toEqual([
      { type: "followStart", target: sam.id },
      { type: "followStart", target: JO.id },
    ]);
    expect(sent("followStop")).toEqual([]);
  });

  it("viewportUpdate from the person I follow goes to the sink; anyone else's is ignored; never a view update", () => {
    const s = sink();
    const { session, relay, views } = joined({ follow: s.sink });
    session.startFollow(sam.id);
    const count = views.length;
    relay.emit({ type: "viewportUpdate", id: sam.id, x: 10, y: 20, zoom: 0.5 });
    relay.emit({ type: "viewportUpdate", id: JO.id, x: 1, y: 1, zoom: 1 });
    expect(s.log.filter((l) => l.startsWith("viewport"))).toEqual([`viewport ${sam.id} 10,20@0.5`]);
    expect(views.length).toBe(count);
  });

  it("followEnded: following stops (sink told the reason); followers_full does the same", () => {
    const s = sink();
    const { session, relay } = joined({ follow: s.sink });
    session.startFollow(sam.id);
    relay.emit({ type: "followEnded", reason: "target_left" });
    expect(s.log.slice(-1)).toEqual(["ended target_left"]);
    expect(session.stopFollow()).toBe(false);
    session.startFollow(JO.id);
    relay.emit({ type: "error", code: "followers_full", message: "No." });
    expect(s.log.slice(-1)).toEqual(["ended followers_full"]);
    expect(session.stopFollow()).toBe(false);
  });

  it("stopOnUserMove: stops following (followStop) when I pan or zoom; nothing when not following", () => {
    const { session, sent } = joined();
    expect(session.stopOnUserMove()).toBe(false);
    session.startFollow(sam.id);
    expect(session.stopOnUserMove()).toBe(true);
    expect(sent("followStop")).toEqual([{ type: "followStop" }]);
    expect(session.stopOnUserMove()).toBe(false);
  });
});

describe("being followed: sending my viewport", () => {
  it("nothing while nobody follows me", () => {
    const { session, sent } = joined();
    expect(session.shareViewport(view(10), false)).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(sent("viewport")).toEqual([]);
  });

  it("followersChanged above 0: my current view goes at once, then changes at most 5 a second; back to 0: nothing more", () => {
    const s = sink();
    const { session, sent, relay } = joined({ follow: s.sink });
    session.shareViewport(view(10), false);
    relay.emit({ type: "followersChanged", count: 1 });
    expect(s.log).toContain("followers 1");
    expect(sent("viewport")).toEqual([{ type: "viewport", x: 10, y: 0, zoom: 1 }]);
    for (let t = 0; t < 1000; t += 20) {
      session.shareViewport(view(11 + t), false);
      vi.advanceTimersByTime(20);
    }
    vi.advanceTimersByTime(FOLLOW_SEND_INTERVAL_MS);
    const inASecond = sent("viewport").length - 1;
    expect(inASecond).toBeGreaterThanOrEqual(4);
    expect(inASecond).toBeLessThanOrEqual(6);
    relay.emit({ type: "followersChanged", count: 0 });
    const before = sent("viewport").length;
    session.shareViewport(view(5000), false);
    vi.advanceTimersByTime(1000);
    expect(sent("viewport")).toHaveLength(before);
  });

  it("only when the view changed", () => {
    const { session, sent, relay } = joined();
    session.shareViewport(view(10), false);
    relay.emit({ type: "followersChanged", count: 1 });
    vi.advanceTimersByTime(1000);
    session.shareViewport(view(10.3), false);
    vi.advanceTimersByTime(1000);
    expect(sent("viewport")).toHaveLength(1);
  });

  it("a second follower gets my view too: the view goes again when the count rises", () => {
    const { session, sent, relay } = joined();
    session.shareViewport(view(10), false);
    relay.emit({ type: "followersChanged", count: 1 });
    vi.advanceTimersByTime(1000);
    relay.emit({ type: "followersChanged", count: 2 });
    expect(sent("viewport")).toHaveLength(2);
    relay.emit({ type: "followersChanged", count: 1 });
    vi.advanceTimersByTime(1000);
    expect(sent("viewport")).toHaveLength(2);
  });

  it("phones never send, followed or not", () => {
    const { session, sent, relay } = joined();
    session.shareViewport(view(10), true);
    relay.emit({ type: "followersChanged", count: 3 });
    session.shareViewport(view(20), true);
    vi.advanceTimersByTime(1000);
    expect(sent("viewport")).toEqual([]);
  });

  it("viewports are whole units on the wire with the zoom to 3 decimals, clamped to the shared bounds", () => {
    const { session, sent, relay } = joined();
    session.shareViewport({ x: 10.6, y: -100000, zoom: 9 }, false);
    relay.emit({ type: "followersChanged", count: 1 });
    expect(sent("viewport")).toEqual([{ type: "viewport", x: 11, y: -256, zoom: 2 }]);
  });
});

describe("bring to me", () => {
  it("as host: bringToMe with my view (rounded); a guest sends nothing", () => {
    const guest = joined();
    expect(guest.session.bringToMe(view(1, 2))).toBe(false);
    expect(guest.sent("bringToMe")).toEqual([]);
    const host = room([], [], { hostToken: () => "fakeHostToken".padEnd(43, "x") }, (relay) => {
      relay.others = [sam];
    });
    expect(host.view().isHost).toBe(true);
    expect(host.session.bringToMe({ x: 300.4, y: 400.6, zoom: 0.75 })).toBe(true);
    expect(host.sent("bringToMe")).toEqual([{ type: "bringToMe", x: 300, y: 401, zoom: 0.75 }]);
  });

  it("broughtToMe from someone here goes to the sink (kept in memory, not a view update); my own or a stranger's is ignored", () => {
    const s = sink();
    const { relay, views } = joined({ follow: s.sink });
    const count = views.length;
    relay.emit({ type: "broughtToMe", from: sam.id, x: 5, y: 6, zoom: 1 });
    relay.emit({ type: "broughtToMe", from: alex.id, x: 7, y: 8, zoom: 1 });
    relay.emit({ type: "broughtToMe", from: "ZZZZZZZZZZZZZZZZ", x: 9, y: 9, zoom: 1 });
    expect(s.log.filter((l) => l.startsWith("brought"))).toEqual([`brought ${sam.id} 5,6@1`]);
    expect(views.length).toBe(count);
  });
});

describe("clearing", () => {
  it("every joined (a new visit or a reconnect) clears; a reconnecting page starts with no follow and no count", async () => {
    const s = sink();
    const { session, relay, sent } = joined({ follow: s.sink });
    session.startFollow(sam.id);
    relay.emit({ type: "followersChanged", count: 2 });
    relay.drop();
    expect(s.log.at(-1)).toBe("clear");
    await vi.advanceTimersByTimeAsync(1500);
    relay.open();
    expect(s.log.at(-1)).toBe("clear");
    // No follow survives: nothing to stop, and my view isn't sent (no count).
    expect(session.stopFollow()).toBe(false);
    session.shareViewport(view(10), false);
    vi.advanceTimersByTime(1000);
    expect(sent("viewport")).toEqual([]);
  });

  it("the person I follow leaves: following stops even before followEnded", () => {
    const s = sink();
    const { session, relay } = joined({ follow: s.sink });
    session.startFollow(sam.id);
    relay.leave(sam.id);
    expect(s.log.at(-1)).toBe("following null");
    expect(session.stopFollow()).toBe(false);
  });

  it("close (Leave) and the room ending clear", () => {
    const s = sink();
    const a = joined({ follow: s.sink });
    a.session.startFollow(sam.id);
    a.session.close();
    expect(s.log.at(-1)).toBe("clear");
    const t = sink();
    const b = joined({ follow: t.sink });
    b.relay.emit({ type: "followersChanged", count: 1 });
    b.relay.emit({ type: "sessionEnded" });
    expect(t.log).toContain("clear");
  });

  it("a pending trailing viewport never goes out after a drop", () => {
    const { session, sent, relay } = joined();
    session.shareViewport(view(10), false);
    relay.emit({ type: "followersChanged", count: 1 });
    session.shareViewport(view(500), false);
    relay.drop();
    vi.advanceTimersByTime(1000);
    expect(sent("viewport")).toHaveLength(1);
  });

  it("follow messages never touch browser storage", () => {
    const get = vi.spyOn(Storage.prototype, "getItem");
    const set = vi.spyOn(Storage.prototype, "setItem");
    const { session, relay } = joined();
    session.startFollow(sam.id);
    relay.emit({ type: "viewportUpdate", id: sam.id, x: 1, y: 1, zoom: 1 });
    relay.emit({ type: "followersChanged", count: 1 });
    session.shareViewport(view(10), false);
    relay.emit({ type: "broughtToMe", from: sam.id, x: 5, y: 6, zoom: 1 });
    session.stopFollow();
    expect(get).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
    get.mockRestore();
    set.mockRestore();
  });
});
