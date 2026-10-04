import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ROOM_ENDED_CLOSE_CODE, ROOM_EXPIRED_CLOSE_CODE } from "@stickyard/shared";
import type { ConnectionEnv } from "../src/connection/reconnect";
import { ENDED_TEXT, NOTICES, RoomSession, timerRemainingMs, type RoomView, type SessionOptions } from "../src/rooms/session";
import { STORAGE_KEYS, hostTokenKey, readKey, removeKey, writeKey, type KeyValueStore } from "../src/storage";
import { Relay, alex, nid, note, room, sam } from "./helpers/fakeRelay";

/*
 * Protocol v12 plumbing (web, no visible host UI yet): the host token is kept per room on the
 * creator's device and sent only in claimHost, after every join and reconnect; lock and timer
 * state; board_locked and not_host refusals; End session (4411) is final like expiry.
 */

const TOKEN = "fakeHostToken".padEnd(43, "x");

function hosted(extra: Partial<SessionOptions> = {}, notes = [note(1), note(2)]) {
  let stored: string | null = TOKEN;
  const forget = vi.fn(() => {
    stored = null;
  });
  const t = room(notes, [], { hostToken: () => stored, forgetHostToken: forget, ...extra });
  return { ...t, forget, stored: () => stored };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("storage", () => {
  it("keeps a host token per room under the stickyard: prefix", () => {
    expect(hostTokenKey("abc")).toBe("stickyard:host:abc");
    expect(hostTokenKey("abc").startsWith(STORAGE_KEYS.hostTokenPrefix)).toBe(true);
    expect(hostTokenKey("abc")).not.toBe(hostTokenKey("abd"));
  });

  it("removeKey never throws", () => {
    const map = new Map<string, string>();
    const store: KeyValueStore = {
      getItem: (k) => map.get(k) ?? null,
      setItem: (k, v) => void map.set(k, v),
      removeItem: (k) => void map.delete(k),
    };
    writeKey(hostTokenKey("r"), TOKEN, store);
    expect(readKey(hostTokenKey("r"), store)).toBe(TOKEN);
    expect(removeKey(hostTokenKey("r"), store)).toBe(true);
    expect(readKey(hostTokenKey("r"), store)).toBeNull();
    const broken: KeyValueStore = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(removeKey("x", broken)).toBe(false);
    expect(removeKey("x", undefined)).toBe(false);
  });
});

describe("claiming host", () => {
  it("sends claimHost right after joined when a token is stored, and becomes host", () => {
    const t = hosted();
    const sent = t.relay.received.map((m) => m.type);
    expect(sent.indexOf("claimHost")).toBeGreaterThan(sent.indexOf("join"));
    expect(t.sent("claimHost")).toEqual([{ type: "claimHost", token: TOKEN }]);
    expect(t.view().isHost).toBe(true);
    expect(t.view().you?.host).toBe(true);
    expect(t.view().participants.find((p) => p.id === alex.id)?.host).toBe(true);
  });

  it("sends nothing without a stored token", () => {
    const t = room([note(1)], [], { hostToken: () => null });
    expect(t.sent("claimHost")).toEqual([]);
    expect(t.view().isHost).toBe(false);
  });

  it("claims again after every reconnect", async () => {
    const t = hosted({ env: { online: () => true, hidden: () => false, listen: () => () => {} } as ConnectionEnv, random: () => 0.5 });
    t.relay.drop();
    expect(t.view().status).toBe("disconnected");
    await vi.advanceTimersByTimeAsync(1000);
    t.relay.open();
    expect(t.view().status).toBe("joined");
    expect(t.sent("claimHost")).toHaveLength(2);
    expect(t.view().isHost).toBe(true);
  });

  it("a refused token is forgotten (and not sent again), quietly", async () => {
    const t = hosted({ env: { online: () => true, hidden: () => false, listen: () => () => {} } as ConnectionEnv, random: () => 0.5 }, []);
    // A fresh session whose token the relay doesn't accept.
    t.relay.hostToken = "otherToken".padEnd(43, "y");
    t.relay.drop();
    await vi.advanceTimersByTimeAsync(1000);
    t.relay.open();
    expect(t.forget).toHaveBeenCalledTimes(1);
    expect(t.view().isHost).toBe(false);
    expect(t.view().noteNotice).toBeNull();
    t.relay.drop();
    await vi.advanceTimersByTimeAsync(1000);
    t.relay.open();
    expect(t.sent("claimHost")).toHaveLength(2);
  });

  it("another participant becoming host updates them in place", () => {
    const t = room([], [], {});
    t.relay.emit({ type: "participantUpdated", participant: { ...sam, host: true } });
    expect(t.view().participants.find((p) => p.id === sam.id)?.host).toBe(true);
    expect(t.view().people.get(sam.id)?.host).toBe(true);
  });
});

describe("lock and timer state", () => {
  it("joined's lock and timer are the starting state, with the clock offset from serverNow", () => {
    vi.setSystemTime(1_000_000);
    const relay = new Relay([], []);
    relay.locked = true;
    // The relay's clock is 5 s ahead of this device's.
    relay.timer = { startedAt: 1_000_000, durationMs: 60_000, serverNow: 1_005_000 };
    const views: RoomView[] = [];
    const session = new RoomSession({
      url: "wss://relay.example.test/ws?room=CODE",
      createSocket: (_u, h) => relay.socket(h),
      checkCode: () => Promise.resolve("valid"),
      onChange: (v) => views.push(v),
    });
    session.join("Alex");
    relay.open();
    const view = views.at(-1)!;
    expect(view.locked).toBe(true);
    expect(view.timer).toEqual({ startedAt: 1_000_000, durationMs: 60_000, offsetMs: 5_000 });
    // Now (device) 1,000,000 = relay 1,005,000: 55 s left.
    expect(timerRemainingMs(view.timer!, 1_000_000)).toBe(55_000);
    expect(timerRemainingMs(view.timer!, 2_000_000)).toBe(0);
  });

  it("lockChanged and timerChanged update the state", () => {
    vi.setSystemTime(2_000_000);
    const t = room([], [], {});
    expect(t.view()).toMatchObject({ locked: false, timer: null });
    t.relay.emit({ type: "lockChanged", locked: true });
    expect(t.view().locked).toBe(true);
    t.relay.emit({ type: "timerChanged", timer: { startedAt: 1_999_000, durationMs: 300_000, serverNow: 1_998_000 } });
    expect(t.view().timer).toEqual({ startedAt: 1_999_000, durationMs: 300_000, offsetMs: -2_000 });
    t.relay.emit({ type: "timerChanged", timer: null });
    expect(t.view().timer).toBeNull();
    t.relay.emit({ type: "lockChanged", locked: false });
    expect(t.view().locked).toBe(false);
  });
});

describe("refusals", () => {
  it("board_locked rolls the change back with one calm notice", () => {
    const t = room([note(1)], [], {});
    const before = t.shown(nid(1))!;
    t.relay.paused = true;
    t.session.startDrag(nid(1));
    t.session.moveNote(nid(1), 500, 500, true);
    expect(t.shown(nid(1))).toMatchObject({ x: 500, y: 500 });
    t.relay.emit({ type: "error", code: "board_locked", message: "Locked.", noteId: nid(1) });
    expect(t.shown(nid(1))).toMatchObject({ x: before.x, y: before.y });
    expect(t.view().noteNotice).toBe(NOTICES.locked);
    expect(NOTICES.locked).toBe("The host has locked the board.");
  });

  it("board_locked on an add (itemsAdd) rolls back its items with the same notice", () => {
    const t = room([note(1)], [], {});
    t.relay.paused = true;
    expect(t.session.duplicateNotes([nid(1)])).not.toBeNull();
    vi.advanceTimersByTime(0);
    const sent = t.relay.received.filter((m) => m.type === "itemsAdd");
    expect(sent).toHaveLength(1);
    expect(t.view().board.notes).toHaveLength(2);
    t.relay.emit({ type: "error", code: "board_locked", message: "Locked.", clientRef: sent[0]!.clientRef });
    expect(t.view().board.notes).toHaveLength(1);
    expect(t.view().noteNotice).toBe(NOTICES.locked);
  });

  it("not_host is a notice", () => {
    const t = room([], [], {});
    t.relay.emit({ type: "error", code: "not_host", message: "Host only." });
    expect(t.view().noteNotice).toBe(NOTICES.notHost);
  });
});

describe("End session (4411) is final, like expiry", () => {
  const env = (): { env: ConnectionEnv; online: () => void } => {
    let on: Parameters<ConnectionEnv["listen"]>[0] | null = null;
    return { env: { online: () => true, hidden: () => false, listen: (l) => ((on = l), () => (on = null)) }, online: () => on?.online() };
  };

  it("sessionEnded: the ended page, the board emptied, the token forgotten, nothing retried", async () => {
    const e = env();
    const health = vi.fn(() => Promise.resolve("ok" as const));
    const t = hosted({ env: e.env, checkHealth: health, random: () => 0.5 });
    t.relay.emit({ type: "sessionEnded" });
    expect(t.view().status).toBe("ended");
    expect(t.view().board.notes).toEqual([]);
    expect(t.view().reconnect).toBeNull();
    expect(t.forget).toHaveBeenCalled();
    t.relay.closeWith(ROOM_ENDED_CLOSE_CODE);
    e.online();
    t.session.rejoin();
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(t.relay.sockets).toBe(1);
    expect(health).not.toHaveBeenCalled();
    expect(t.view().status).toBe("ended");
  });

  it("4411 on a reconnect (ended while you were away): the ended page, no more tries", async () => {
    const e = env();
    const t = hosted({ env: e.env, random: () => 0.5 });
    t.relay.drop();
    await vi.advanceTimersByTimeAsync(1000);
    t.relay.closeWith(ROOM_ENDED_CLOSE_CODE);
    expect(t.view().status).toBe("ended");
    expect(t.forget).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(t.relay.sockets).toBe(2);
  });

  it("4411 on the first join: the ended page", () => {
    const relay = new Relay([], []);
    const views: RoomView[] = [];
    const forget = vi.fn();
    const session = new RoomSession({
      url: "wss://relay.example.test/ws?room=CODE",
      createSocket: (_u, h) => relay.socket(h),
      checkCode: () => Promise.resolve("valid"),
      onChange: (v) => views.push(v),
      hostToken: () => TOKEN,
      forgetHostToken: forget,
    });
    session.join("Alex");
    relay.closeWith(ROOM_ENDED_CLOSE_CODE);
    expect(views.at(-1)!.status).toBe("ended");
    expect(forget).toHaveBeenCalled();
  });

  it("4410 (expired) forgets the token too", () => {
    const t = hosted();
    t.relay.closeWith(ROOM_EXPIRED_CLOSE_CODE);
    expect(t.view().status).toBe("expired");
    expect(t.forget).toHaveBeenCalled();
  });

  it("says who ended it", () => {
    expect(ENDED_TEXT.body).toBe("This session was ended by the host.");
    expect(ENDED_TEXT.home).toBe("Go to the start page");
  });
});

describe("host commands (facilitation UI)", () => {
  it("startRoomTimer sends timerStart within the relay's bounds; stopRoomTimer sends timerStop", () => {
    const t = hosted();
    expect(t.session.startRoomTimer(300_000)).toBe(true);
    expect(t.session.startRoomTimer(0)).toBe(false);
    expect(t.session.startRoomTimer(3 * 60 * 60 * 1000 + 1)).toBe(false);
    expect(t.session.startRoomTimer(1500.5)).toBe(false);
    expect(t.sent("timerStart")).toEqual([{ type: "timerStart", durationMs: 300_000 }]);
    expect(t.session.stopRoomTimer()).toBe(true);
    expect(t.sent("timerStop")).toEqual([{ type: "timerStop" }]);
  });

  it("host commands are refused (nothing sent) for a guest or while disconnected", () => {
    const guest = room([], [], {});
    expect(guest.session.startRoomTimer(60_000)).toBe(false);
    expect(guest.session.stopRoomTimer()).toBe(false);
    expect(guest.sent("timerStart")).toEqual([]);
    const t = hosted();
    t.relay.drop();
    expect(t.session.startRoomTimer(60_000)).toBe(false);
    expect(t.sent("timerStart")).toEqual([]);
  });
});
