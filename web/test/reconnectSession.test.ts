import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FRAME_DEFAULTS, MAX_FRAMES_PER_ROOM, PROTOCOL_VERSION, type Participant } from "@stickyard/shared";
import { EXPECT_TIMEOUT_MS, HISTORY_TEXT } from "../src/history/history";
import { LIMIT_MAX_PROBES, LIMIT_RETRY_MS, RECONNECT_MAX_ATTEMPTS, type ConnectionEnv, type ProbeResult } from "../src/connection/reconnect";
import { findFrame } from "../src/frames/board";
import { findNote } from "../src/notes/board";
import { CLEAR_FRAME_STEP_MS, DROP_TEXT, ITEMS_STEP_MS, JOIN_TIMEOUT_MS, NOTICES, UNDO_TEXT, type SessionOptions } from "../src/rooms/session";
import { alex, fid, frame, nid, note, room, sam } from "./helpers/fakeRelay";

/*
 * Reconnect (web only, no protocol change): a dropped connection reconnects on its own with
 * backoff, then the relay's snapshots replace the board. Anything unconfirmed at the drop is
 * discarded with one notice; runs end as partial as before; a draft being typed is kept.
 */

type Listeners = Parameters<ConnectionEnv["listen"]>[0];

function fakeEnv() {
  let online = true;
  let hidden = false;
  let on: Listeners | null = null;
  const env: ConnectionEnv = {
    online: () => online,
    hidden: () => hidden,
    listen: (l) => {
      on = l;
      return () => {
        on = null;
      };
    },
  };
  return {
    env,
    goOffline() {
      online = false;
      on?.offline();
    },
    goOnline() {
      online = true;
      on?.online();
    },
    hide() {
      hidden = true;
      on?.visibility();
    },
    show() {
      hidden = false;
      on?.visibility();
    },
    get listening() {
      return on !== null;
    },
  };
}

function setup(notes = [note(1), note(2)], frames = [frame(1)], extra: Partial<SessionOptions> = {}) {
  const e = fakeEnv();
  const health = vi.fn<() => Promise<ProbeResult>>(() => Promise.resolve("ok"));
  const code = vi.fn(() => Promise.resolve("valid" as const));
  const t = room(notes, frames, { env: e.env, random: () => 0.5, checkHealth: health, checkCode: code, ...extra });
  /** Waits for the next automatic try and lets the relay accept it. */
  const reconnect = async () => {
    const before = t.relay.sockets;
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.relay.sockets).toBe(before + 1);
    t.relay.open();
  };
  return { ...t, e, health, code, reconnect };
}

const plan = (i: number) => ({ x: 2000 + i * 700, y: 100, w: 640, h: 400, title: `T${i}`, color: "neutral" as const, style: { ...FRAME_DEFAULTS } });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("a dropped connection", () => {
  it("reconnects on its own after about a second, in the same session, and is live again", async () => {
    const t = setup();
    t.relay.drop();
    expect(t.view().status).toBe("disconnected");
    expect(t.view().reconnect).toEqual({ phase: "reconnecting", attempt: 1, max: RECONNECT_MAX_ATTEMPTS });
    await vi.advanceTimersByTimeAsync(999);
    expect(t.relay.sockets).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.relay.sockets).toBe(2);
    expect(t.view().status).toBe("disconnected");
    t.relay.open();
    expect(t.view().status).toBe("joined");
    expect(t.view().reconnect).toBeNull();
    expect(t.view().board.notes.map((n) => n.note.id)).toEqual([nid(1), nid(2)]);
  });

  it("backs off 1, 2, 4, 8, 16, 30, 30, 30 seconds, then stops and says Offline", async () => {
    const t = setup();
    t.relay.drop();
    const delays = [1000, 2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000];
    for (const [i, d] of delays.entries()) {
      expect(t.view().reconnect).toEqual({ phase: "reconnecting", attempt: i + 1, max: 8 });
      await vi.advanceTimersByTimeAsync(d - 1);
      expect(t.relay.sockets).toBe(1 + i);
      await vi.advanceTimersByTimeAsync(1);
      expect(t.relay.sockets).toBe(2 + i);
      // Opens, then the relay closes it before the join is answered.
      t.relay.paused = true;
      t.relay.open();
      t.relay.drop();
      t.relay.paused = false;
    }
    expect(t.view().reconnect).toEqual({ phase: "offline", attempt: 8, max: 8 });
    await vi.advanceTimersByTimeAsync(24 * 3600_000);
    expect(t.relay.sockets).toBe(9);
  });

  it("Rejoin after giving up starts again at once, with the backoff from the start", async () => {
    const t = setup();
    t.relay.drop();
    for (let i = 0; i < 8; i++) {
      await vi.advanceTimersByTimeAsync(30_000);
      t.relay.paused = true;
      t.relay.open();
      t.relay.drop();
      t.relay.paused = false;
    }
    expect(t.view().reconnect?.phase).toBe("offline");
    t.session.rejoin();
    expect(t.relay.sockets).toBe(10);
    expect(t.view().reconnect).toEqual({ phase: "reconnecting", attempt: 1, max: 8 });
    t.relay.open();
    expect(t.view().status).toBe("joined");
  });

  it("a try that isn't answered in time counts as a failed try (not unreachable) and the next one is scheduled", async () => {
    const t = setup();
    t.relay.drop();
    await vi.advanceTimersByTimeAsync(1000);
    t.relay.paused = true;
    t.relay.open();
    await vi.advanceTimersByTimeAsync(JOIN_TIMEOUT_MS);
    expect(t.relay.closes).toBe(1);
    expect(t.view().status).toBe("disconnected");
    expect(t.view().reconnect).toEqual({ phase: "reconnecting", attempt: 2, max: 8 });
    t.relay.paused = false;
    await vi.advanceTimersByTimeAsync(2000);
    expect(t.relay.sockets).toBe(3);
  });

  it("close() (leaving) stops reconnecting and stops listening to the browser", async () => {
    const t = setup();
    t.relay.drop();
    t.session.close();
    await vi.advanceTimersByTimeAsync(3600_000);
    expect(t.relay.sockets).toBe(1);
    expect(t.e.listening).toBe(false);
  });
});

describe("browser triggers", () => {
  it("online: tries at once", async () => {
    const t = setup();
    t.relay.drop();
    await vi.advanceTimersByTimeAsync(1000);
    t.relay.failOpen();
    expect(t.relay.sockets).toBe(2);
    // The next automatic try is 2 s away; the network coming back doesn't wait for it.
    await vi.advanceTimersByTimeAsync(1000);
    t.e.goOnline();
    expect(t.relay.sockets).toBe(3);
  });

  it("never a tight loop: events in quick succession make one try", async () => {
    const t = setup();
    t.relay.drop();
    t.e.goOnline();
    t.relay.failOpen();
    t.e.goOnline();
    t.e.show();
    t.e.goOnline();
    expect(t.relay.sockets).toBe(2);
  });

  it("offline while joined: drops at once and waits for the network, then tries when it's back", async () => {
    const t = setup();
    t.e.goOffline();
    expect(t.relay.closes).toBe(1);
    expect(t.view().status).toBe("disconnected");
    expect(t.view().reconnect).toEqual({ phase: "network", attempt: 1, max: 8 });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(t.relay.sockets).toBe(1);
    t.e.goOnline();
    expect(t.relay.sockets).toBe(2);
    t.relay.open();
    expect(t.view().status).toBe("joined");
  });

  it("online after giving up starts again", async () => {
    const t = setup();
    t.relay.drop();
    for (let i = 0; i < 8; i++) {
      await vi.advanceTimersByTimeAsync(30_000);
      t.relay.paused = true;
      t.relay.open();
      t.relay.drop();
      t.relay.paused = false;
    }
    expect(t.view().reconnect?.phase).toBe("offline");
    await vi.advanceTimersByTimeAsync(1000);
    t.e.goOnline();
    expect(t.relay.sockets).toBe(10);
  });

  it("a tab hidden for long doesn't try; it tries as soon as it's visible again", async () => {
    const t = setup();
    t.e.hide();
    t.relay.drop();
    // Within the grace period the first tries still happen.
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.relay.sockets).toBe(2);
    t.relay.failOpen();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    const sockets = t.relay.sockets;
    expect(sockets).toBeLessThan(9);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(t.relay.sockets).toBe(sockets);
    t.e.show();
    expect(t.relay.sockets).toBe(sockets + 1);
  });

  it("becoming visible while waiting tries at once", async () => {
    const t = setup();
    t.relay.drop();
    t.e.hide();
    t.e.show();
    expect(t.relay.sockets).toBe(2);
  });
});

describe("fatal outcomes don't retry", () => {
  it("version_mismatch on a reconnect: please reload", async () => {
    const t = setup();
    t.relay.drop();
    t.relay.joinError = "version_mismatch";
    await t.reconnect();
    expect(t.view().status).toBe("reload");
    await vi.advanceTimersByTimeAsync(3600_000);
    expect(t.relay.sockets).toBe(2);
  });

  it("a welcome for another protocol: please reload", async () => {
    const t = setup();
    t.relay.drop();
    t.relay.welcomeVersion = PROTOCOL_VERSION + 1;
    await t.reconnect();
    expect(t.view().status).toBe("reload");
    await vi.advanceTimersByTimeAsync(3600_000);
    expect(t.relay.sockets).toBe(2);
  });

  it("room full on a reconnect: says so, offers Rejoin, and doesn't retry by itself", async () => {
    const t = setup();
    t.relay.drop();
    t.relay.joinError = "room_full";
    await t.reconnect();
    expect(t.view().status).toBe("disconnected");
    expect(t.view().reconnect).toEqual({ phase: "full", attempt: 1, max: 8 });
    await vi.advanceTimersByTimeAsync(3600_000);
    expect(t.relay.sockets).toBe(2);
    t.relay.joinError = null;
    t.session.rejoin();
    expect(t.relay.sockets).toBe(3);
    t.relay.open();
    expect(t.view().status).toBe("joined");
  });

  it("a link the relay says is invalid (the relay itself is up): the invalid-link page, no retry", async () => {
    const t = setup();
    t.code.mockResolvedValue("invalid" as never);
    t.relay.drop();
    for (const d of [1000, 2000, 4000]) {
      await vi.advanceTimersByTimeAsync(d);
      t.relay.failOpen();
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(t.view().status).toBe("invalid");
    await vi.advanceTimersByTimeAsync(3600_000);
    expect(t.relay.sockets).toBe(4);
  });
});

describe("relay unreachable or over its daily limit", () => {
  it("doesn't probe for the first two failed opens", async () => {
    const t = setup();
    t.relay.drop();
    await vi.advanceTimersByTimeAsync(1000);
    t.relay.failOpen();
    await vi.advanceTimersByTimeAsync(2000);
    t.relay.failOpen();
    expect(t.health).not.toHaveBeenCalled();
  });

  it("after three failed opens with a failing health probe: says it may be over its limit and slows to one probe a minute", async () => {
    const t = setup();
    t.health.mockResolvedValue("down");
    t.relay.drop();
    await vi.advanceTimersByTimeAsync(1000);
    t.relay.failOpen();
    await vi.advanceTimersByTimeAsync(2000);
    t.relay.failOpen();
    await vi.advanceTimersByTimeAsync(4000);
    t.relay.failOpen();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.health).toHaveBeenCalledTimes(1);
    expect(t.view().reconnect).toEqual({ phase: "limit", attempt: 3, max: 8 });
    // While it's down only the cheap probe runs, once a minute; no sockets.
    await vi.advanceTimersByTimeAsync(LIMIT_RETRY_MS - 1);
    expect(t.health).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.health).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(LIMIT_RETRY_MS * 3);
    expect(t.health).toHaveBeenCalledTimes(5);
    expect(t.relay.sockets).toBe(4);
    // The relay is back: the next probe opens a socket at once.
    t.health.mockResolvedValue("ok");
    await vi.advanceTimersByTimeAsync(LIMIT_RETRY_MS);
    expect(t.relay.sockets).toBe(5);
    t.relay.open();
    expect(t.view().status).toBe("joined");
    expect(t.view().reconnect).toBeNull();
  });

  it(`stops probing after ${LIMIT_MAX_PROBES} minutes and says Offline; Rejoin starts again`, async () => {
    const t = setup();
    t.health.mockResolvedValue("down");
    t.relay.drop();
    for (const d of [1000, 2000, 4000]) {
      await vi.advanceTimersByTimeAsync(d);
      t.relay.failOpen();
    }
    await vi.advanceTimersByTimeAsync(LIMIT_RETRY_MS * (LIMIT_MAX_PROBES + 5));
    expect(t.health).toHaveBeenCalledTimes(LIMIT_MAX_PROBES);
    expect(t.view().reconnect?.phase).toBe("offline");
    t.session.rejoin();
    expect(t.relay.sockets).toBe(5);
  });

  it("no probes while the tab is hidden; one as soon as it's visible", async () => {
    const t = setup();
    t.health.mockResolvedValue("down");
    t.relay.drop();
    for (const d of [1000, 2000, 4000]) {
      await vi.advanceTimersByTimeAsync(d);
      t.relay.failOpen();
    }
    await vi.advanceTimersByTimeAsync(0);
    t.e.hide();
    await vi.advanceTimersByTimeAsync(LIMIT_RETRY_MS * 10);
    expect(t.health).toHaveBeenCalledTimes(1);
    t.e.show();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.health).toHaveBeenCalledTimes(2);
  });

  it("a healthy relay keeps the normal backoff (the link is checked too)", async () => {
    const t = setup();
    t.relay.drop();
    for (const d of [1000, 2000, 4000]) {
      await vi.advanceTimersByTimeAsync(d);
      t.relay.failOpen();
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(t.health).toHaveBeenCalledTimes(1);
    expect(t.code).toHaveBeenCalledTimes(1);
    expect(t.view().reconnect).toEqual({ phase: "reconnecting", attempt: 4, max: 8 });
    await vi.advanceTimersByTimeAsync(8000);
    expect(t.relay.sockets).toBe(5);
  });

  it("a health probe from a newer relay: please reload", async () => {
    const t = setup();
    t.health.mockResolvedValue("reload");
    t.relay.drop();
    for (const d of [1000, 2000, 4000]) {
      await vi.advanceTimersByTimeAsync(d);
      t.relay.failOpen();
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(t.view().status).toBe("reload");
  });
});

describe("rejoining", () => {
  it("uses the stored name, with no prompt", async () => {
    const t = setup(undefined, undefined, { storedName: () => "Alexandra" });
    t.relay.drop();
    await t.reconnect();
    expect(t.sent("join").at(-1)).toEqual({ type: "join", name: "Alexandra" });
    expect(t.view().you?.name).toBe("Alexandra");
  });

  it("without a stored name, uses the name it joined with", async () => {
    const t = setup(undefined, undefined, { storedName: () => null });
    t.relay.drop();
    await t.reconnect();
    expect(t.sent("join").at(-1)).toEqual({ type: "join", name: "Alex" });
  });

  it("copes with a new participant id and colour: you, participants, people and every id you had", async () => {
    const t = setup();
    const newMe: Participant = { id: "CCCCCCCCCCCCCCCC", name: "Alex", colourIndex: 5 };
    t.relay.drop();
    t.relay.you = newMe;
    await t.reconnect();
    expect(t.view().you).toEqual(newMe);
    expect(t.view().participants).toEqual([newMe, sam]);
    expect([...t.view().yourIds].sort()).toEqual([alex.id, newMe.id].sort());
    expect(t.view().people.get(alex.id)?.name).toBe("Alex");
    expect(t.view().people.get(newMe.id)?.colourIndex).toBe(5);
  });

  it("chat already received stays; nothing is sent while down", async () => {
    const t = setup();
    t.session.say("hello");
    expect(t.view().messages.map((m) => m.text)).toEqual(["hello"]);
    t.relay.drop();
    expect(t.session.say("lost")).toBe(false);
    await t.reconnect();
    expect(t.view().messages.map((m) => m.text)).toEqual(["hello"]);
    expect(t.sent("say")).toHaveLength(1);
  });
});

describe("resync replaces the board", () => {
  it("notes and frames are exactly the relay's, even at lower revs (no merge by rev)", async () => {
    const t = setup([note(1, { rev: 9 }), note(2)], [frame(1, { rev: 7 }), frame(2)]);
    t.relay.drop();
    // A restarted relay: older revs, one note gone, one new.
    t.relay.notes.set(nid(1), note(1, { text: "Fresh", rev: 1 }));
    t.relay.notes.delete(nid(2));
    t.relay.notes.set(nid(3), note(3));
    t.relay.frames.set(fid(1), frame(1, { title: "Renamed", rev: 1 }));
    t.relay.frames.delete(fid(2));
    await t.reconnect();
    expect(t.view().board.notes.map((n) => n.note)).toEqual([...t.relay.notes.values()]);
    expect(t.view().board.notes.every((n) => n.confirmed === n.note)).toBe(true);
    expect(t.view().board.frames.map((f) => f.frame)).toEqual([...t.relay.frames.values()]);
    expect(t.view().dropReport).toBeNull();
  });

  it("the board counts as joined after the notes snapshot; frames arriving late replace the old ones, with no new sync (no fit)", async () => {
    const t = setup([note(1)], [frame(1), frame(2)]);
    t.relay.drop();
    t.relay.holdFrames = true;
    t.relay.frames.delete(fid(1));
    t.relay.frames.set(fid(2), frame(2, { title: "Kept", rev: 1 }));
    t.relay.frames.set(fid(3), frame(3));
    const from = t.views.length;
    await t.reconnect();
    expect(t.view().status).toBe("joined");
    // The old frames stay until the frames message arrives.
    expect(t.view().board.frames.map((f) => f.frame.id)).toEqual([fid(1), fid(2)]);
    t.relay.sendFrames();
    expect(t.view().board.frames.map((f) => f.frame)).toEqual([...t.relay.frames.values()]);
    // `synced` never went back to false, so the canvas keeps the user's view.
    expect(t.views.slice(from).every((v) => v.synced)).toBe(true);
  });

  it("joined isn't reported before the snapshot on a reconnect (the stale board can't be edited)", async () => {
    const t = setup();
    t.relay.drop();
    t.relay.notes.delete(nid(2));
    await vi.advanceTimersByTimeAsync(1000);
    // Every view as the join answers arrive: the first joined one already has the relay's notes.
    const from = t.views.length;
    t.relay.open();
    const joined = t.views.slice(from).filter((v) => v.status === "joined");
    expect(joined[0]?.board.notes.map((n) => n.note.id)).toEqual([nid(1)]);
  });

  it("undo history is cleared on resync, and the bar says nothing alarming", async () => {
    const t = setup();
    t.session.moveNote(nid(1), 300, 300, true);
    expect(t.view().history.undo).toBeNull();
    t.relay.drop();
    expect(t.view().history).toEqual({ undo: UNDO_TEXT.offline, redo: UNDO_TEXT.offline });
    await t.reconnect();
    expect(t.view().history).toEqual({ undo: HISTORY_TEXT.nothingToUndo, redo: HISTORY_TEXT.nothingToRedo });
    t.session.undo();
    expect(t.relay.notes.get(nid(1))?.x).toBe(300);
  });
});

describe("unconfirmed work is discarded at the drop, with one notice", () => {
  type T = ReturnType<typeof setup>;
  it.each<[string, (t: T) => void, number]>([
    ["a note add", (t) => void t.session.addNote({ x: 500, y: 500, color: "pink" }), 1],
    ["a text edit", (t) => void t.session.editNote(nid(1), "Changed"), 1],
    ["a style change", (t) => void t.session.styleNote(nid(1), { bold: true, color: "blue" }), 1],
    [
      "a move",
      (t) => {
        t.session.startDrag(nid(1));
        t.session.moveNote(nid(1), 300, 300, true);
      },
      1,
    ],
    ["a resize", (t) => void t.session.setNoteSize(nid(1), 300, 300), 1],
    ["a delete", (t) => t.session.deleteNote(nid(1)), 1],
    ["a frame add", (t) => void t.session.addFrame({ x: 900, y: 900, color: "blue" }), 1],
    ["a frame edit", (t) => void t.session.editFrame(fid(1), { title: "New" }), 1],
    ["a frame resize", (t) => void t.session.setFrameSize(fid(1), 800, 500), 1],
    ["a frame delete", (t) => t.session.deleteFrame(fid(1)), 1],
    ["a duplicate (itemsAdd)", (t) => void t.session.duplicateNotes([nid(1), nid(2)]), 2],
    [
      "an edit and a move of the same note (one note)",
      (t) => {
        t.session.editNote(nid(1), "Changed");
        t.session.moveNote(nid(1), 300, 300, true);
      },
      1,
    ],
    [
      "a drag still in progress",
      (t) => {
        t.session.startDrag(nid(2));
        t.session.moveNote(nid(2), 700, 700, false);
      },
      1,
    ],
  ])("%s", (_label, act, count) => {
    const t = setup();
    const notesBefore = [...t.relay.notes.values()];
    const framesBefore = [...t.relay.frames.values()];
    t.relay.paused = true;
    act(t);
    t.relay.drop();
    expect(t.view().dropReport).toBe(DROP_TEXT.unsaved(count));
    // What's shown is what the relay last confirmed.
    expect(t.view().board.notes.map((n) => n.note)).toEqual(notesBefore);
    expect(t.view().board.frames.map((f) => f.frame)).toEqual(framesBefore);
    expect(t.view().board.removed).toEqual([]);
    expect(t.view().board.framesRemoved).toEqual([]);
  });

  it("the notice reads naturally", () => {
    expect(DROP_TEXT.unsaved(1)).toBe("1 change may not have been saved because the connection dropped.");
    expect(DROP_TEXT.unsaved(3)).toBe("3 changes may not have been saved because the connection dropped.");
  });

  it("nothing unconfirmed: no notice; someone else's live drag isn't counted", () => {
    const t = setup();
    t.relay.handlers!.onMessage(JSON.stringify({ type: "noteMoved", id: nid(2), x: 999, y: 999, rev: 1, final: false }));
    t.relay.drop();
    expect(t.view().dropReport).toBeNull();
  });

  it("the notice stays through the reconnect and goes with the next note action", async () => {
    const t = setup();
    t.relay.paused = true;
    t.session.editNote(nid(1), "Changed");
    t.relay.drop();
    t.relay.paused = false;
    await t.reconnect();
    expect(t.view().dropReport).toBe(DROP_TEXT.unsaved(1));
    expect(t.view().board.notes[0]?.note.text).toBe("Note 1");
    t.session.editNote(nid(2), "Next");
    expect(t.view().dropReport).toBeNull();
  });

  it("a template cut off ends as partial (as before), and isn't counted again", () => {
    const t = setup();
    t.relay.paused = true;
    t.session.applyTemplate([plan(0), plan(1)]);
    t.relay.drop();
    expect(t.view().template?.state).toBe("partial");
    expect(t.view().noteNotice).toBe(NOTICES.templatePartial);
    expect(t.view().dropReport).toBeNull();
    expect(t.view().board.frames.map((f) => f.frame.id)).toEqual([fid(1)]);
  });

  it("a delete of several notes cut off: its report covers the loss, the notes are back, nothing counted twice", () => {
    const t = setup();
    t.relay.paused = true;
    t.session.deleteNotes([nid(1), nid(2)]);
    t.relay.drop();
    expect(t.view().deleteReport?.partial).toBe(true);
    expect(t.view().deleteReport?.text).toContain("connection was lost");
    expect(t.view().dropReport).toBeNull();
    expect(t.view().board.notes.map((n) => n.note.id)).toEqual([nid(1), nid(2)]);
  });

  it("Clear board cut off: partial report with counts, not counted again", () => {
    const t = setup();
    t.relay.paused = true;
    t.session.clearBoard();
    t.relay.drop();
    expect(t.view().deleteReport?.partial).toBe(true);
    expect(t.view().clearing).toBe(false);
    expect(t.view().dropReport).toBeNull();
  });

  it("a restore (undo of a delete) cut off: partial with counts, not counted again", async () => {
    const t = setup();
    t.session.deleteNote(nid(1));
    expect(t.relay.notes.has(nid(1))).toBe(false);
    t.relay.paused = true;
    t.session.undo();
    t.relay.drop();
    expect(t.view().historyReport).toEqual({ text: UNDO_TEXT.restoreLost(0, 1), partial: true });
    expect(t.view().dropReport).toBeNull();
  });

  it("other work alongside a run is still counted", () => {
    const t = setup();
    t.relay.paused = true;
    t.session.deleteNotes([nid(2)]);
    t.session.editFrame(fid(1), { title: "New" });
    t.relay.drop();
    expect(t.view().dropReport).toBe(DROP_TEXT.unsaved(1));
  });
});

describe("the fake relay drops the socket mid-run", () => {
  const big = (i: number) => note(i, { text: "\uD800".repeat(280), x: 10 * i, y: 10 });

  it("mid-itemsAdd: what was answered stays, the rest is discarded and counted, nothing more is sent after the reconnect", async () => {
    const t = setup([big(1), big(2), big(3), big(4), big(5), big(6)], []);
    t.session.duplicateNotes([nid(1), nid(2), nid(3), nid(4), nid(5), nid(6)]);
    // Two notes a message at most: the first went and was answered, two are queued.
    expect(t.sent("itemsAdd")).toHaveLength(1);
    t.relay.paused = true;
    await vi.advanceTimersByTimeAsync(ITEMS_STEP_MS);
    expect(t.sent("itemsAdd")).toHaveLength(2);
    t.relay.drop();
    expect(t.view().dropReport).toBe(DROP_TEXT.unsaved(4));
    expect(t.view().adding).toBe(false);
    expect(t.view().board.notes).toHaveLength(8);
    t.relay.paused = false;
    await t.reconnect();
    await vi.advanceTimersByTimeAsync(ITEMS_STEP_MS * 10);
    expect(t.sent("itemsAdd")).toHaveLength(2);
    expect(t.view().board.notes.map((n) => n.note.id)).toEqual([...t.relay.notes.keys()]);
  });

  it("mid-Clear board: frames not sent stay, the report says what may not have gone, nothing more is sent after the reconnect", async () => {
    const frames = Array.from({ length: MAX_FRAMES_PER_ROOM }, (_, i) => frame(i));
    const t = setup([note(1), note(2)], frames);
    t.session.clearBoard();
    await vi.advanceTimersByTimeAsync(CLEAR_FRAME_STEP_MS * 4);
    const deleted = t.sent("frameDelete").length;
    expect(deleted).toBeGreaterThan(0);
    expect(deleted).toBeLessThan(MAX_FRAMES_PER_ROOM);
    t.relay.drop();
    expect(t.view().deleteReport).toMatchObject({ partial: true });
    expect(t.view().deleteReport?.text).toContain("connection was lost");
    expect(t.view().clearing).toBe(false);
    await t.reconnect();
    await vi.advanceTimersByTimeAsync(CLEAR_FRAME_STEP_MS * MAX_FRAMES_PER_ROOM);
    expect(t.sent("frameDelete")).toHaveLength(deleted);
    expect(t.view().board.frames.map((f) => f.frame.id)).toEqual([...t.relay.frames.keys()]);
    expect(t.view().board.frames).toHaveLength(MAX_FRAMES_PER_ROOM - deleted);
    expect(t.view().board.notes).toEqual([]);
  });
});

describe("a draft being typed", () => {
  it("is kept through the drop and the resync, then commits normally", async () => {
    const t = setup();
    t.session.setDraft(nid(1), "Typing away");
    t.relay.drop();
    expect(findNote(t.view().board, nid(1))?.draft).toBe("Typing away");
    t.session.setDraft(nid(1), "Typing away offline");
    await t.reconnect();
    expect(findNote(t.view().board, nid(1))?.draft).toBe("Typing away offline");
    expect(t.view().orphanDraft).toBeNull();
    expect(t.session.editNote(nid(1), "Typing away offline")).toBe(true);
    expect(t.relay.notes.get(nid(1))?.text).toBe("Typing away offline");
  });

  it("whose note is gone after the resync is kept and can be added back as a new note", async () => {
    const t = setup();
    t.session.setDraft(nid(1), "Precious words");
    t.relay.drop();
    t.relay.notes.delete(nid(1));
    await t.reconnect();
    expect(findNote(t.view().board, nid(1))).toBeUndefined();
    expect(t.view().orphanDraft).toMatchObject({ text: "Precious words" });
    const id = t.session.restoreDraft();
    expect(id).not.toBeNull();
    expect(t.sent("noteAdd").at(-1)).toMatchObject({ text: "Precious words" });
    expect(t.view().orphanDraft).toBeNull();
  });

  it("in a note still being added when the connection dropped is kept the same way; Dismiss forgets it", () => {
    const t = setup();
    t.relay.paused = true;
    const id = t.session.addNote({ x: 40, y: 40, color: "green" })!;
    t.session.setDraft(id, "New idea");
    t.relay.drop();
    expect(findNote(t.view().board, id)).toBeUndefined();
    expect(t.view().orphanDraft).toMatchObject({ text: "New idea" });
    t.session.dismissDraft();
    expect(t.view().orphanDraft).toBeNull();
  });

  it("a frame title being typed is kept when the frame survives", async () => {
    const t = setup();
    t.session.setFrameDraft(fid(1), "Half a tit");
    t.relay.drop();
    await t.reconnect();
    expect(findFrame(t.view().board, fid(1))?.draft).toBe("Half a tit");
  });
});

describe("waiting undo entries", () => {
  it("dropped after 10 s refresh the Undo and Redo reasons without any other event (the stale-button bug)", async () => {
    const t = setup();
    t.relay.paused = true;
    t.session.moveNote(nid(1), 300, 300, true);
    expect(t.view().history.undo).toBe(HISTORY_TEXT.unsaved);
    const views = t.views.length;
    await vi.advanceTimersByTimeAsync(EXPECT_TIMEOUT_MS + 1);
    expect(t.views.length).toBeGreaterThan(views);
    expect(t.view().history.undo).toBe(HISTORY_TEXT.nothingToUndo);
  });

  it("no timer is kept when nothing is waiting", async () => {
    const t = setup();
    t.session.moveNote(nid(1), 300, 300, true);
    const views = t.views.length;
    await vi.advanceTimersByTimeAsync(EXPECT_TIMEOUT_MS * 3);
    expect(t.views.length).toBe(views);
  });
});
