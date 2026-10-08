import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NOTE_DEFAULTS, PROTOCOL_VERSION, type Note, type Participant } from "@stickyard/shared";
import type { SocketFactory, SocketHandlers } from "../src/connection/socket";
import { NOTICES, RoomSession, type RoomView } from "../src/rooms/session";
import {
  SILENT_HINTS,
  SILENT_UI,
  confirmRevealText,
  confirmStartText,
  hostSilentReasons,
  noteCountText,
  revealedOutside,
  silentAnnouncement,
  silentStripText,
} from "../src/silent/silent";

/*
 * Silent brainstorm, part 3 (UI): the pure texts and rules, and the session state the UI reads
 * (the host's pending action, and what the last reveal brought). Fake keys only.
 */

class FakeSocket {
  sent: Record<string, unknown>[] = [];
  constructor(readonly handlers: SocketHandlers) {}
  send = (data: string) => void this.sent.push(JSON.parse(data) as Record<string, unknown>);
  close = () => undefined;
  open = () => this.handlers.onOpen();
  receive = (data: unknown) => this.handlers.onMessage(JSON.stringify(data));
  serverClose = () => this.handlers.onClose();
  ofType = (type: string) => this.sent.filter((m) => m.type === type);
}

const host: Participant = { id: "AAAAAAAAAAAAAAAA", name: "Hana", colourIndex: 0, host: true };
const sam: Participant = { id: "BBBBBBBBBBBBBBBB", name: "Sam", colourIndex: 1, host: false };
const nid = (i: number) => `note${String(i).padStart(12, "0")}`;
const note = (i: number, extra: Partial<Note> = {}): Note => ({ id: nid(i), x: 10 * i, y: 20, ...NOTE_DEFAULTS, text: `Note ${i}`, color: "yellow", z: i, rev: 1, authorId: sam.id, ...extra });

function joined({ silent = { active: false, count: 0 }, notes = [] as Note[], mine = null as string[] | null } = {}) {
  const sockets: FakeSocket[] = [];
  const views: RoomView[] = [];
  const createSocket: SocketFactory = (_url, handlers) => {
    const s = new FakeSocket(handlers);
    sockets.push(s);
    return s;
  };
  const session = new RoomSession({
    url: "wss://relay.example.test/ws?room=CODE",
    createSocket,
    checkCode: () => Promise.resolve("valid"),
    onChange: (v) => views.push(v),
    random: () => 0.5,
    voterKey: () => "fakeWriterKey".padEnd(22, "k"),
  });
  session.join("Hana");
  const sock = () => sockets.at(-1)!;
  sock().open();
  sock().receive({ type: "welcome", protocolVersion: PROTOCOL_VERSION });
  sock().receive({ type: "joined", you: host, participants: [sam, host], locked: false, timer: null, voting: { state: "off", budget: 5, round: 0 }, silent });
  sock().receive({ type: "snapshot", notes });
  sock().receive({ type: "framesSnapshot", frames: [] });
  sock().receive({ type: "shapesSnapshot", shapes: [] });
  if (mine) sock().receive({ type: "silentMine", ids: mine });
  return { session, sock, view: () => views.at(-1)! };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("texts and rules (pure)", () => {
  it("the strip: what's happening, then the numbers; the cap's room only when close", () => {
    expect(silentStripText({ active: false, count: 0 }, 0)).toBeNull();
    expect(silentStripText({ active: true, count: 5 }, 2)).toEqual({
      lead: "Silent brainstorm: write your ideas. Nobody sees them until the host reveals.",
      counts: "You’ve written 2. 5 notes written in total.",
    });
    expect(silentStripText({ active: true, count: 1 }, 1)?.counts).toBe("You’ve written 1. 1 note written in total.");
    expect(silentStripText({ active: true, count: 0 }, 0)?.counts).toBe("You’ve written 0. 0 notes written in total.");
    // MAX_SEALED_PER_WRITER is 40: the room left shows from 5 left.
    expect(silentStripText({ active: true, count: 40 }, 35)?.counts).toBe("You’ve written 35. 40 notes written in total. 5 left.");
    expect(silentStripText({ active: true, count: 40 }, 34)?.counts).toBe("You’ve written 34. 40 notes written in total.");
    expect(silentStripText({ active: true, count: 40 }, 40)?.counts).toBe("You’ve written 40. 40 notes written in total. 0 left.");
  });

  it("announcements: not on joining; started; revealed with the count known before the reveal; never twice", () => {
    expect(silentAnnouncement(null, { active: true, count: 3 })).toBeNull();
    expect(silentAnnouncement({ active: false, count: 0 }, { active: true, count: 0 })).toBe(SILENT_UI.started);
    expect(silentAnnouncement({ active: true, count: 7 }, { active: false, count: 0 })).toBe("7 notes revealed.");
    expect(silentAnnouncement({ active: true, count: 1 }, { active: false, count: 0 })).toBe("1 note revealed.");
    expect(silentAnnouncement({ active: true, count: 2 }, { active: true, count: 3 })).toBeNull();
    expect(silentAnnouncement({ active: false, count: 0 }, { active: false, count: 0 })).toBeNull();
  });

  it("the start confirm states the three facts; the lock and an open vote add a line each", () => {
    const base = [
      "Start a silent round?",
      "",
      "• Notes added from now on stay hidden from everyone but the person who wrote them, you included, until you reveal them.",
      "• Only this device can reveal them, so keep this page open. If you lose it, the hidden notes stay hidden until the session expires.",
      "• While it runs, frames can’t be moved, and Clear board and Start voting are off.",
    ];
    expect(confirmStartText({ locked: false, votingOpen: false })).toBe(base.join("\n"));
    expect(confirmStartText({ locked: true, votingOpen: false })).toBe([...base, "• The board is locked, so guests can’t add notes until you unlock it."].join("\n"));
    expect(confirmStartText({ locked: false, votingOpen: true })).toBe([...base, "• Voting stays open, but nobody can vote on hidden notes until they’re revealed."].join("\n"));
  });

  it("the reveal confirm: one way, the number of hidden notes, everyone at once", () => {
    expect(confirmRevealText(7)).toBe("Reveal the hidden notes?\n\nEveryone will see all 7 hidden notes at once, and the silent round ends. This can’t be undone.");
    expect(confirmRevealText(1)).toBe("Reveal the hidden notes?\n\nEveryone will see the 1 hidden note at once, and the silent round ends. This can’t be undone.");
    expect(confirmRevealText(0)).toBe("Reveal the hidden notes?\n\nThere are no hidden notes. This ends the silent round for everyone and can’t be undone.");
  });

  it("host reasons: offline, waiting for the relay, a round already running or none running; an open vote doesn't stop Start (the relay allows it)", () => {
    expect(hostSilentReasons({ live: false, active: false, pending: null })).toEqual({ start: SILENT_HINTS.offline, reveal: SILENT_HINTS.offline });
    expect(hostSilentReasons({ live: true, active: false, pending: null })).toEqual({ start: null, reveal: SILENT_HINTS.none });
    expect(hostSilentReasons({ live: true, active: true, pending: null })).toEqual({ start: SILENT_HINTS.running, reveal: null });
    expect(hostSilentReasons({ live: true, active: false, pending: "start" })).toEqual({ start: SILENT_HINTS.waiting, reveal: SILENT_HINTS.waiting });
    expect(SILENT_HINTS).toMatchObject({ offline: "Not connected.", running: "A silent round is already running.", none: "No silent round is running.", waiting: "Waiting for the relay…" });
  });

  it("the board count: everyone's notes, honest about the hidden ones", () => {
    expect(noteCountText({ shown: 4, silent: { active: false, count: 0 }, mine: 0 })).toBe("4 of 200 notes");
    expect(noteCountText({ shown: 4, silent: { active: true, count: 5 }, mine: 2 })).toBe("4 notes you can see, 3 hidden: 7 of 200 notes");
    expect(noteCountText({ shown: 1, silent: { active: true, count: 1 }, mine: 1 })).toBe("1 note you can see, 0 hidden: 1 of 200 notes");
    expect(noteCountText({ shown: 0, silent: { active: true, count: 0 }, mine: 0 })).toBe("0 notes you can see, 0 hidden: 0 of 200 notes");
  });

  it("after a reveal: the Fit line only when a revealed note is out of view", () => {
    expect(revealedOutside([], () => false)).toBe(false);
    expect(revealedOutside([nid(1), nid(2)], () => true)).toBe(false);
    expect(revealedOutside([nid(1), nid(2)], (id) => id === nid(1))).toBe(true);
  });
});

describe("the session: the host's pending action", () => {
  it("Start is pending until the relay's silentChanged; Reveal likewise", () => {
    const t = joined();
    expect(t.view().silentPending).toBeNull();
    expect(t.session.startSilent()).toBe(true);
    expect(t.view().silentPending).toBe("start");
    t.sock().receive({ type: "silentChanged", active: true, count: 0 });
    expect(t.view().silentPending).toBeNull();
    expect(t.session.revealSilent()).toBe(true);
    expect(t.view().silentPending).toBe("reveal");
    t.sock().receive({ type: "silentChanged", active: false, count: 0 });
    expect(t.view().silentPending).toBeNull();
  });

  it("a refusal ends it with the existing plain message; so does a dropped connection", () => {
    const t = joined();
    t.session.startSilent();
    t.sock().receive({ type: "error", code: "not_host", message: "No." });
    expect(t.view().silentPending).toBeNull();
    expect(t.view().noteNotice).toBe(NOTICES.notHost);
    t.session.startSilent();
    t.sock().receive({ type: "error", code: "silent_active", message: "No." });
    expect(t.view().silentPending).toBeNull();
    t.session.startSilent();
    t.sock().serverClose();
    expect(t.view().silentPending).toBeNull();
  });
});

describe("the session: what the last reveal brought", () => {
  it("the notes new to this page, the count known before it, once per reveal", () => {
    const t = joined({ silent: { active: true, count: 3 }, notes: [note(1, { authorId: host.id })], mine: [nid(1)] });
    expect(t.view().lastReveal).toBeNull();
    t.sock().receive({ type: "notesRevealed", notes: [note(1, { authorId: host.id }), note(2)], final: false });
    t.sock().receive({ type: "notesRevealed", notes: [note(3)], final: true });
    t.sock().receive({ type: "silentChanged", active: false, count: 0 });
    const first = t.view().lastReveal;
    expect(first).toEqual({ seq: 1, count: 3, ids: [nid(2), nid(3)] });
    // A late chunk changes nothing and isn't news.
    t.sock().receive({ type: "notesRevealed", notes: [note(3)], final: true });
    expect(t.view().lastReveal).toBe(first);
    // The next round's reveal is a new one.
    t.sock().receive({ type: "silentChanged", active: true, count: 0 });
    t.sock().receive({ type: "silentChanged", active: true, count: 1 });
    t.sock().receive({ type: "notesRevealed", notes: [note(4)], final: true });
    t.sock().receive({ type: "silentChanged", active: false, count: 0 });
    expect(t.view().lastReveal).toEqual({ seq: 2, count: 1, ids: [nid(4)] });
  });

  it("joining after a reveal, or a round that never ran, has none", () => {
    const t = joined({ notes: [note(1)] });
    t.sock().receive({ type: "silentChanged", active: false, count: 0 });
    expect(t.view().lastReveal).toBeNull();
  });
});
