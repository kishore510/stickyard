import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION } from "@stickyard/shared";
import {
  CONNECT_TIMEOUT_MS,
  startConnectionCheck,
  type CheckStatus,
  type SocketFactory,
  type SocketHandlers,
} from "../src/connection/connectionCheck";

/** A fake socket the test drives by hand. */
class FakeSocket {
  sent: string[] = [];
  closed = false;
  constructor(
    readonly url: string,
    readonly handlers: SocketHandlers,
  ) {}
  send = (data: string) => {
    this.sent.push(data);
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
  receiveRaw(data: unknown) {
    this.handlers.onMessage(data);
  }
  serverClose() {
    this.handlers.onClose();
  }
  fail() {
    this.handlers.onError();
  }
}

function setup() {
  const statuses: CheckStatus[] = [];
  let socket: FakeSocket | undefined;
  const createSocket: SocketFactory = (url, handlers) => {
    socket = new FakeSocket(url, handlers);
    return socket;
  };
  const stop = startConnectionCheck({
    url: "wss://relay.example.test/ws",
    createSocket,
    onStatus: (s) => statuses.push(s),
  });
  const sock = () => {
    if (!socket) throw new Error("no socket created");
    return socket;
  };
  return { statuses, sock, stop, last: () => statuses.at(-1) };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("connection check", () => {
  it("starts in connecting and opens the given URL", () => {
    const t = setup();
    expect(t.last()).toBe("connecting");
    expect(t.sock().url).toBe("wss://relay.example.test/ws");
  });

  it("sends hello with the protocol version on open", () => {
    const t = setup();
    t.sock().open();
    expect(t.sock().sent.map((s) => JSON.parse(s))).toEqual([{ type: "hello", protocolVersion: PROTOCOL_VERSION }]);
    expect(t.last()).toBe("connecting");
  });

  it("becomes connected on a matching welcome", () => {
    const t = setup();
    t.sock().open();
    t.sock().receive({ type: "welcome", protocolVersion: PROTOCOL_VERSION });
    expect(t.last()).toBe("connected");
  });

  describe("please reload", () => {
    it("on a version_mismatch error", () => {
      const t = setup();
      t.sock().open();
      t.sock().receive({ type: "error", code: "version_mismatch", message: "x" });
      expect(t.last()).toBe("reload");
    });

    it("on a welcome with a different protocol version", () => {
      const t = setup();
      t.sock().open();
      t.sock().receive({ type: "welcome", protocolVersion: PROTOCOL_VERSION + 1 });
      expect(t.last()).toBe("reload");
    });

    it("on a server message this client cannot understand", () => {
      const t = setup();
      t.sock().open();
      t.sock().receive({ type: "something_new" });
      expect(t.last()).toBe("reload");
    });

    it("stays on reload when the socket then closes", () => {
      const t = setup();
      t.sock().open();
      t.sock().receive({ type: "error", code: "version_mismatch", message: "x" });
      t.sock().serverClose();
      expect(t.last()).toBe("reload");
      expect(t.sock().closed).toBe(true);
    });
  });

  describe("cannot connect", () => {
    it("when the socket closes before welcome", () => {
      const t = setup();
      t.sock().serverClose();
      expect(t.last()).toBe("unreachable");
    });

    it("on a socket error", () => {
      const t = setup();
      t.sock().fail();
      expect(t.last()).toBe("unreachable");
    });

    it("when the connection is lost after connecting", () => {
      const t = setup();
      t.sock().open();
      t.sock().receive({ type: "welcome", protocolVersion: PROTOCOL_VERSION });
      t.sock().serverClose();
      expect(t.last()).toBe("unreachable");
    });

    it("on other server errors", () => {
      const t = setup();
      t.sock().open();
      t.sock().receive({ type: "error", code: "rate_limited", message: "x" });
      expect(t.last()).toBe("unreachable");
    });

    it("after the connect timeout, and closes the socket", () => {
      const t = setup();
      vi.advanceTimersByTime(CONNECT_TIMEOUT_MS - 1);
      expect(t.last()).toBe("connecting");
      vi.advanceTimersByTime(1);
      expect(t.last()).toBe("unreachable");
      expect(t.sock().closed).toBe(true);
    });

    it("when the socket cannot even be created", () => {
      const statuses: CheckStatus[] = [];
      startConnectionCheck({
        url: "not a url",
        createSocket: () => {
          throw new Error("SyntaxError");
        },
        onStatus: (s) => statuses.push(s),
      });
      expect(statuses.at(-1)).toBe("unreachable");
    });
  });

  it("does not time out once connected", () => {
    const t = setup();
    t.sock().open();
    t.sock().receive({ type: "welcome", protocolVersion: PROTOCOL_VERSION });
    vi.advanceTimersByTime(CONNECT_TIMEOUT_MS * 2);
    expect(t.last()).toBe("connected");
  });

  it("ignores non-string frames as not understood", () => {
    const t = setup();
    t.sock().open();
    t.sock().receiveRaw(new ArrayBuffer(4));
    expect(t.last()).toBe("reload");
  });

  it("stop() closes the socket and reports nothing further", () => {
    const t = setup();
    const count = t.statuses.length;
    t.stop();
    expect(t.sock().closed).toBe(true);
    t.sock().serverClose();
    vi.advanceTimersByTime(CONNECT_TIMEOUT_MS);
    expect(t.statuses.length).toBe(count);
  });
});
