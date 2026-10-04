import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ROOM_EXPIRED_CLOSE_CODE, ROOM_IDLE_EXPIRY_DAYS } from "@stickyard/shared";
import type { ConnectionEnv, ProbeResult } from "../src/connection/reconnect";
import { EXPIRED_TEXT, RoomSession, type RoomView } from "../src/rooms/session";
import { Relay, frame, note, room } from "./helpers/fakeRelay";

/*
 * Idle room expiry (web side): the relay closes a socket to an expired room with 4410. That code,
 * and only it, is final: no retries, no health probes, no Rejoin, and the board goes.
 */

function setup() {
  let on: Parameters<ConnectionEnv["listen"]>[0] | null = null;
  const env: ConnectionEnv = { online: () => true, hidden: () => false, listen: (l) => ((on = l), () => (on = null)) };
  const health = vi.fn<() => Promise<ProbeResult>>(() => Promise.resolve("ok"));
  const code = vi.fn(() => Promise.resolve("valid" as const));
  const t = room([note(1)], [frame(1)], { env, random: () => 0.5, checkHealth: health, checkCode: code });
  return { ...t, health, code, online: () => on?.online() };
}

/** A session whose first socket hasn't opened yet (nothing answered). */
function joining() {
  const relay = new Relay([], []);
  const views: RoomView[] = [];
  const health = vi.fn<() => Promise<ProbeResult>>(() => Promise.resolve("ok"));
  const code = vi.fn(() => Promise.resolve("valid" as const));
  const session = new RoomSession({
    url: "wss://relay.example.test/ws?room=CODE",
    createSocket: (_url, handlers) => relay.socket(handlers),
    checkCode: code,
    checkHealth: health,
    onChange: (v) => views.push(v),
  });
  session.join("Alex");
  return { relay, session, health, code, view: () => views.at(-1)! };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("4410 (the room has expired)", () => {
  it("is the shared close code, and the text says 7 days", () => {
    expect(ROOM_EXPIRED_CLOSE_CODE).toBe(4410);
    expect(EXPIRED_TEXT.body).toContain(`${ROOM_IDLE_EXPIRY_DAYS} days`);
    expect(EXPIRED_TEXT.body).toBe("This session has expired because nobody used it for 7 days. Start a new session from the start page.");
  });

  it.each([
    ["before the socket opens", false],
    ["after it opens, before the welcome", true],
  ])("on the first join (%s): status expired, no retry, no probe, no room check", async (_label, opened) => {
    const t = joining();
    if (opened) {
      t.relay.paused = true;
      t.relay.open();
    }
    t.relay.closeWith(ROOM_EXPIRED_CLOSE_CODE);
    expect(t.view().status).toBe("expired");
    expect(t.view().reconnect).toBeNull();
    await vi.advanceTimersByTimeAsync(3600_000);
    expect(t.relay.sockets).toBe(1);
    expect(t.health).not.toHaveBeenCalled();
    expect(t.code).not.toHaveBeenCalled();
    expect(t.view().status).toBe("expired");
  });

  it("on a reconnect (it expired while you were away): expired, history gone, no more tries or probes", async () => {
    const t = setup();
    t.relay.open();
    expect(t.view().status).toBe("joined");
    t.relay.drop();
    expect(t.view().status).toBe("disconnected");
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.relay.sockets).toBe(2);
    t.relay.closeWith(ROOM_EXPIRED_CLOSE_CODE);
    expect(t.view().status).toBe("expired");
    expect(t.view().reconnect).toBeNull();
    expect(t.view().board.notes).toEqual([]);
    expect(t.view().board.frames).toEqual([]);
    expect(t.view().history.undo).not.toBeNull();
    expect(t.view().history.redo).not.toBeNull();
    await vi.advanceTimersByTimeAsync(3600_000);
    t.online();
    t.session.rejoin();
    await vi.advanceTimersByTimeAsync(3600_000);
    expect(t.relay.sockets).toBe(2);
    expect(t.health).not.toHaveBeenCalled();
    expect(t.code).not.toHaveBeenCalled();
    expect(t.view().status).toBe("expired");
  });

  it("other close codes are unchanged: a drop still reconnects", async () => {
    const t = setup();
    t.relay.open();
    t.relay.closeWith(1006);
    expect(t.view().status).toBe("disconnected");
    expect(t.view().reconnect?.phase).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.relay.sockets).toBe(2);
    t.relay.closeWith(4000);
    expect(t.view().status).toBe("disconnected");
    await vi.advanceTimersByTimeAsync(2000);
    expect(t.relay.sockets).toBe(3);
  });

  it("other close codes on the first join are unchanged: unreachable once opened, a room check if never opened", async () => {
    const a = joining();
    a.relay.paused = true;
    a.relay.open();
    a.relay.closeWith(1008);
    expect(a.view().status).toBe("unreachable");
    const b = joining();
    b.relay.closeWith(1006);
    await vi.advanceTimersByTimeAsync(0);
    expect(b.code).toHaveBeenCalledTimes(1);
    expect(b.view().status).toBe("unreachable");
  });
});
