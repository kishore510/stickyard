import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, clientMessageSchema, type Participant, type ServerMessage } from "@stickyard/shared";
import type { ConnectionEnv } from "../src/connection/reconnect";
import type { SocketHandlers } from "../src/connection/socket";
import type { CursorSink } from "../src/cursors/cursors";
import { RoomSession, type RoomView } from "../src/rooms/session";
import { alex, room, sam } from "./helpers/fakeRelay";

/*
 * Live cursors in the session (protocol v14): when it sends, what it does with others' cursors,
 * and two pages through a small relay that forwards cursors like the Worker (others only).
 */

/** A cursor sink that records what the session told it. */
function sink() {
  const log: string[] = [];
  const cursors = new Map<string, { x: number; y: number }>();
  const s: CursorSink = {
    moved: (id, x, y) => {
      log.push(`moved ${id} ${x},${y}`);
      cursors.set(id, { x, y });
    },
    gone: (id) => {
      log.push(`gone ${id}`);
      cursors.delete(id);
    },
    clear: () => {
      log.push("clear");
      cursors.clear();
    },
  };
  return { sink: s, log, cursors };
}

/** A browser env whose visibility the test flips. */
function env() {
  let hidden = false;
  let on: { visibility(): void } | null = null;
  const e: ConnectionEnv = {
    online: () => true,
    hidden: () => hidden,
    listen: (handlers) => {
      on = handlers;
      return () => {};
    },
  };
  return {
    env: e,
    hide: (value: boolean) => {
      hidden = value;
      on?.visibility();
    },
  };
}

function joined(options: Parameters<typeof room>[2] = {}, others: Participant[] = [sam]) {
  const r = room([], [], options, (relay) => {
    relay.others = others;
  });
  return r;
}

describe("sending", () => {
  it("sends cursor while someone else is here; whole units on the wire", () => {
    const { session, sent } = joined();
    expect(session.shareCursor(10.4, 20.6)).toBe(true);
    expect(sent("cursor")).toEqual([{ type: "cursor", x: 10, y: 21 }]);
  });

  it("never sends when nobody else is in the room", () => {
    const { session, sent, relay } = joined({}, []);
    expect(session.shareCursor(10, 20)).toBe(false);
    expect(sent("cursor")).toEqual([]);
    // Someone arrives: now it sends.
    relay.arrive(sam);
    expect(session.shareCursor(10, 20)).toBe(true);
    // They leave: it stops again.
    relay.leave(sam.id);
    expect(session.shareCursor(11, 20)).toBe(false);
    expect(sent("cursor")).toHaveLength(1);
  });

  it("never sends while disconnected or reconnecting", () => {
    const { session, sent, relay } = joined();
    relay.drop();
    expect(session.shareCursor(10, 20)).toBe(false);
    session.hideCursor();
    expect(sent("cursor")).toEqual([]);
    expect(sent("cursorLeft")).toEqual([]);
  });

  it("pauses while the tab is hidden: cursorLeft once on hiding, nothing sent while hidden", () => {
    const browser = env();
    const { session, sent } = joined({ env: browser.env });
    session.shareCursor(10, 20);
    browser.hide(true);
    expect(sent("cursorLeft")).toEqual([{ type: "cursorLeft" }]);
    expect(session.shareCursor(30, 40)).toBe(false);
    browser.hide(false);
    expect(session.shareCursor(30, 40)).toBe(true);
    expect(sent("cursor")).toHaveLength(2);
  });

  it("cursorLeft only when the cursor was shown, and only once", () => {
    const { session, sent } = joined();
    session.hideCursor();
    expect(sent("cursorLeft")).toEqual([]);
    session.shareCursor(10, 20);
    session.hideCursor();
    session.hideCursor();
    expect(sent("cursorLeft")).toEqual([{ type: "cursorLeft" }]);
  });

  it("cursor messages don't touch the history, notices or the board", () => {
    const { session, view } = joined();
    const before = view();
    session.shareCursor(10, 20);
    session.hideCursor();
    expect(view()).toBe(before);
  });
});

describe("receiving", () => {
  it("passes others' cursors to the sink; ignores my own and unknown participants", () => {
    const s = sink();
    const { relay } = joined({ cursors: s.sink });
    relay.emit({ type: "cursorMoved", id: sam.id, x: 5, y: 6 });
    relay.emit({ type: "cursorMoved", id: alex.id, x: 7, y: 8 });
    relay.emit({ type: "cursorMoved", id: "ZZZZZZZZZZZZZZZZ", x: 1, y: 1 });
    expect([...s.cursors]).toEqual([[sam.id, { x: 5, y: 6 }]]);
  });

  it("cursor messages are not view updates (notes never re-render for them)", () => {
    const s = sink();
    const { relay, views } = joined({ cursors: s.sink });
    const count = views.length;
    for (let i = 0; i < 10; i++) relay.emit({ type: "cursorMoved", id: sam.id, x: i, y: i });
    relay.emit({ type: "cursorGone", id: sam.id });
    expect(views.length).toBe(count);
  });

  it("removes a cursor on cursorGone and when its participant leaves", () => {
    const s = sink();
    const kai: Participant = { id: "CCCCCCCCCCCCCCCC", name: "Kai", colourIndex: 2, host: false };
    const { relay } = joined({ cursors: s.sink }, [sam, kai]);
    relay.emit({ type: "cursorMoved", id: sam.id, x: 5, y: 6 });
    relay.emit({ type: "cursorMoved", id: kai.id, x: 5, y: 6 });
    relay.emit({ type: "cursorGone", id: sam.id });
    expect([...s.cursors.keys()]).toEqual([kai.id]);
    relay.leave(kai.id);
    expect(s.cursors.size).toBe(0);
  });

  it("clears every cursor on a drop, and again on the reconnect's resync", () => {
    const s = sink();
    const { relay } = joined({ cursors: s.sink });
    relay.emit({ type: "cursorMoved", id: sam.id, x: 5, y: 6 });
    relay.drop();
    expect(s.cursors.size).toBe(0);
    expect(s.log.at(-1)).toBe("clear");
  });

  it("clears on End session and expiry, and on leaving", () => {
    for (const end of ["ended", "expired", "leave"] as const) {
      const s = sink();
      const { relay, session } = joined({ cursors: s.sink });
      relay.emit({ type: "cursorMoved", id: sam.id, x: 5, y: 6 });
      if (end === "ended") relay.emit({ type: "sessionEnded" });
      else if (end === "expired") relay.closeWith(4410);
      else session.close();
      expect(s.cursors.size, end).toBe(0);
    }
  });
});

/*
 * Two pages through one relay that forwards cursors like the Worker: to the other joined pages,
 * with the sender's id, never back to the sender.
 */
class TwoPageRelay {
  private pages: { handlers: SocketHandlers; you: Participant | null }[] = [];
  received: Record<string, unknown>[] = [];
  private people = [alex, sam];
  private out(page: { handlers: SocketHandlers }, m: ServerMessage) {
    page.handlers.onMessage(JSON.stringify(m));
  }
  /** The newest page's socket opens. */
  openLast() {
    this.pages.at(-1)?.handlers.onOpen();
  }
  socket = (handlers: SocketHandlers) => {
    const page = { handlers, you: null as Participant | null };
    this.pages.push(page);
    return {
      send: (data: string) => {
        const m = JSON.parse(data) as Record<string, unknown>;
        expect(clientMessageSchema.safeParse(m).success).toBe(true);
        this.received.push(m);
        const joinedPages = () => this.pages.filter((p) => p.you !== null);
        switch (m.type) {
          case "hello":
            return this.out(page, { type: "welcome", protocolVersion: PROTOCOL_VERSION });
          case "join": {
            page.you = this.people[this.pages.indexOf(page)]!;
            const participants = joinedPages().map((p) => p.you!);
            this.out(page, { type: "joined", you: page.you, participants, locked: false, timer: null, voting: { state: "off", budget: 5, round: 0 } });
            this.out(page, { type: "snapshot", notes: [] });
            this.out(page, { type: "framesSnapshot", frames: [] });
            for (const p of joinedPages()) if (p !== page) this.out(p, { type: "participant_joined", participant: page.you });
            return;
          }
          case "cursor":
          case "cursorLeft":
            for (const p of joinedPages()) {
              if (p === page || !page.you) continue;
              this.out(p, m.type === "cursor" ? { type: "cursorMoved", id: page.you.id, x: m.x as number, y: m.y as number } : { type: "cursorGone", id: page.you.id });
            }
            return;
        }
      },
      close: () => {
        const left = page.you;
        page.you = null;
        if (left) for (const p of this.pages.filter((q) => q.you)) this.out(p, { type: "participant_left", id: left.id });
      },
    };
  };
}

describe("two pages", () => {
  it("Alex's pointer shows on Sam's page, never on Alex's own; leaving removes it", () => {
    const relay = new TwoPageRelay();
    const a = sink();
    const b = sink();
    const views: RoomView[] = [];
    const page = (s: CursorSink) =>
      new RoomSession({ url: "wss://relay.example.test/ws", createSocket: (_u, h) => relay.socket(h), checkCode: () => Promise.resolve("valid"), onChange: (v) => views.push(v), cursors: s });
    const alexPage = page(a.sink);
    alexPage.join("Alex");
    relay.openLast();
    // Alone: nothing is sent.
    expect(alexPage.shareCursor(1, 1)).toBe(false);
    const samPage = page(b.sink);
    samPage.join("Sam");
    relay.openLast();
    expect(alexPage.shareCursor(100, 200)).toBe(true);
    expect(samPage.shareCursor(300, 400)).toBe(true);
    expect([...b.cursors]).toEqual([[alex.id, { x: 100, y: 200 }]]);
    expect([...a.cursors]).toEqual([[sam.id, { x: 300, y: 400 }]]);
    alexPage.hideCursor();
    expect(b.cursors.size).toBe(0);
    alexPage.shareCursor(110, 210);
    expect(b.cursors.get(alex.id)).toEqual({ x: 110, y: 210 });
    alexPage.close();
    expect(b.cursors.size).toBe(0);
    samPage.close();
  });
});
