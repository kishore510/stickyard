import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION, type Participant } from "@stickyard/shared";
import type { SocketFactory, SocketHandlers } from "../src/connection/socket";
import type { CodeCheck } from "../src/rooms/api";
import { JOIN_TIMEOUT_MS, MAX_MESSAGES, RoomSession, type RoomView } from "../src/rooms/session";

class FakeSocket {
  sent: unknown[] = [];
  closed = false;
  constructor(
    readonly url: string,
    readonly handlers: SocketHandlers,
  ) {}
  send = (data: string) => {
    this.sent.push(JSON.parse(data));
  };
  close = () => {
    this.closed = true;
  };
  open() {
    this.handlers.onOpen();
  }
  receive(data: unknown) {
    this.handlers.onMessage(typeof data === "string" ? data : JSON.stringify(data));
  }
  serverClose() {
    this.handlers.onClose();
  }
}

const alex: Participant = { id: "AAAAAAAAAAAAAAAA", name: "Alex", colourIndex: 0 };
const sam: Participant = { id: "BBBBBBBBBBBBBBBB", name: "Sam", colourIndex: 1 };

function setup(check: CodeCheck = "valid") {
  const sockets: FakeSocket[] = [];
  const views: RoomView[] = [];
  const createSocket: SocketFactory = (url, handlers) => {
    const s = new FakeSocket(url, handlers);
    sockets.push(s);
    return s;
  };
  const checkCode = vi.fn(() => Promise.resolve(check));
  const session = new RoomSession({
    url: "wss://relay.example.test/ws?room=CODE",
    createSocket,
    checkCode,
    onChange: (v) => views.push(v),
  });
  const sock = () => {
    const s = sockets.at(-1);
    if (!s) throw new Error("no socket");
    return s;
  };
  const view = () => {
    const v = views.at(-1);
    if (!v) throw new Error("no view");
    return v;
  };
  return { session, sockets, sock, view, checkCode };
}

/** Join as Alex, with Sam already in the room. */
function joined() {
  const t = setup();
  t.session.join("Alex");
  t.sock().open();
  t.sock().receive({ type: "welcome", protocolVersion: PROTOCOL_VERSION });
  t.sock().receive({ type: "joined", you: alex, participants: [sam, alex] });
  return t;
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("joining", () => {
  it("connects, says hello, then joins with the name", () => {
    const t = setup();
    t.session.join("Alex");
    expect(t.view().status).toBe("connecting");
    expect(t.sock().url).toBe("wss://relay.example.test/ws?room=CODE");
    t.sock().open();
    expect(t.sock().sent).toEqual([{ type: "hello", protocolVersion: PROTOCOL_VERSION }]);
    t.sock().receive({ type: "welcome", protocolVersion: PROTOCOL_VERSION });
    expect(t.sock().sent.at(-1)).toEqual({ type: "join", name: "Alex" });
  });

  it("is joined, with the server's participant list", () => {
    const t = joined();
    expect(t.view()).toMatchObject({ status: "joined", you: alex, participants: [sam, alex] });
  });

  it("an invalid name keeps the socket and lets the person try again", () => {
    const t = setup();
    t.session.join("x");
    t.sock().open();
    t.sock().receive({ type: "welcome", protocolVersion: PROTOCOL_VERSION });
    t.sock().receive({ type: "error", code: "invalid_name", message: "x" });
    expect(t.view()).toMatchObject({ status: "idle", nameError: true });
    t.session.join("Alex");
    expect(t.sockets).toHaveLength(1);
    expect(t.sock().sent.at(-1)).toEqual({ type: "join", name: "Alex" });
    expect(t.view().nameError).toBe(false);
  });

  it("room_full shows the full state and closes", () => {
    const t = setup();
    t.session.join("Alex");
    t.sock().open();
    t.sock().receive({ type: "welcome", protocolVersion: PROTOCOL_VERSION });
    t.sock().receive({ type: "error", code: "room_full", message: "x" });
    expect(t.view().status).toBe("full");
    expect(t.sock().closed).toBe(true);
  });

  it.each([
    ["version_mismatch", { type: "error", code: "version_mismatch", message: "x" }],
    ["a welcome for another protocol", { type: "welcome", protocolVersion: PROTOCOL_VERSION + 1 }],
    ["a message this page can't understand", { type: "something_new" }],
  ])("%s means please reload", (_label, message) => {
    const t = setup();
    t.session.join("Alex");
    t.sock().open();
    t.sock().receive(message);
    expect(t.view().status).toBe("reload");
    expect(t.sock().closed).toBe(true);
  });

  it("a socket that fails before opening checks the code: invalid", async () => {
    const t = setup("invalid");
    t.session.join("Alex");
    t.sock().serverClose();
    await flush();
    expect(t.checkCode).toHaveBeenCalled();
    expect(t.view().status).toBe("invalid");
  });

  it("a socket that fails before opening checks the code: valid means unreachable", async () => {
    const t = setup("valid");
    t.session.join("Alex");
    t.sock().serverClose();
    await flush();
    expect(t.view().status).toBe("unreachable");
  });

  it("times out to unreachable", () => {
    const t = setup();
    t.session.join("Alex");
    t.sock().open();
    vi.advanceTimersByTime(JOIN_TIMEOUT_MS);
    expect(t.view().status).toBe("unreachable");
    expect(t.sock().closed).toBe(true);
  });

  it("does not time out once joined", () => {
    const t = joined();
    vi.advanceTimersByTime(JOIN_TIMEOUT_MS * 2);
    expect(t.view().status).toBe("joined");
  });
});

describe("in the room", () => {
  it("adds and removes participants, and announces them", () => {
    const t = joined();
    const kai: Participant = { id: "CCCCCCCCCCCCCCCC", name: "Kai", colourIndex: 2 };
    t.sock().receive({ type: "participant_joined", participant: kai });
    expect(t.view().participants).toEqual([sam, alex, kai]);
    expect(t.view().announcement).toBe("Kai joined");
    t.sock().receive({ type: "participant_left", id: sam.id });
    expect(t.view().participants).toEqual([alex, kai]);
    expect(t.view().announcement).toBe("Sam left");
  });

  it("echoes carry the sender's name and colour, kept after they leave", () => {
    const t = joined();
    t.sock().receive({ type: "echo", from: sam.id, text: "hi" });
    t.sock().receive({ type: "participant_left", id: sam.id });
    expect(t.view().messages).toEqual([{ key: expect.any(Number), from: sam.id, name: "Sam", colourIndex: 1, text: "hi" }]);
  });

  it("ignores echoes from unknown senders", () => {
    const t = joined();
    t.sock().receive({ type: "echo", from: "ZZZZZZZZZZZZZZZZ", text: "who?" });
    expect(t.view().messages).toEqual([]);
  });

  it(`keeps the last ${MAX_MESSAGES} messages`, () => {
    const t = joined();
    for (let i = 0; i < MAX_MESSAGES + 5; i++) t.sock().receive({ type: "echo", from: sam.id, text: `m${i}` });
    expect(t.view().messages).toHaveLength(MAX_MESSAGES);
    expect(t.view().messages.at(-1)?.text).toBe(`m${MAX_MESSAGES + 4}`);
  });

  it("say sends cleaned text, and refuses blank text", () => {
    const t = joined();
    expect(t.session.say("  hello ​ world ")).toBe(true);
    expect(t.sock().sent.at(-1)).toEqual({ type: "say", text: "hello world" });
    const count = t.sock().sent.length;
    expect(t.session.say("   ")).toBe(false);
    expect(t.sock().sent).toHaveLength(count);
  });

  it("say does nothing before joining", () => {
    const t = setup();
    t.session.join("Alex");
    t.sock().open();
    expect(t.session.say("hi")).toBe(false);
  });

  it("rate_limited shows a notice until the next accepted message", () => {
    const t = joined();
    t.sock().receive({ type: "error", code: "rate_limited", message: "x" });
    expect(t.view().rateLimited).toBe(true);
    t.sock().receive({ type: "echo", from: alex.id, text: "ok" });
    expect(t.view().rateLimited).toBe(false);
  });

  it("losing the connection after joining is disconnected", () => {
    const t = joined();
    t.sock().serverClose();
    expect(t.view().status).toBe("disconnected");
  });

  it("close() closes the socket and reports nothing further", () => {
    const t = joined();
    const before = t.view();
    t.session.close();
    expect(t.sock().closed).toBe(true);
    t.sock().serverClose();
    expect(t.view()).toBe(before);
  });
});
