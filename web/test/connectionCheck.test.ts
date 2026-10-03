import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION } from "@stickyard/shared";
import { CONNECT_TIMEOUT_MS, startConnectionCheck, type CheckStatus } from "../src/connection/connectionCheck";

/*
 * The home-screen status line: a plain GET /health (no WebSocket, no Durable Object),
 * comparing the relay's protocol version with this page's.
 */

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

function setup(fetchFn: FetchFn) {
  const statuses: CheckStatus[] = [];
  const calls: [string, RequestInit | undefined][] = [];
  const spy: FetchFn = (input, init) => {
    calls.push([input, init]);
    return fetchFn(input, init);
  };
  const stop = startConnectionCheck({
    url: "https://relay.example.test/health",
    fetch: spy,
    onStatus: (s) => statuses.push(s),
  });
  return { statuses, calls, stop, last: () => statuses.at(-1) };
}

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

/** Lets pending promise callbacks run. */
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await vi.advanceTimersByTimeAsync(0);
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("connection check (GET /health)", () => {
  it("starts in connecting and fetches the health URL without caching", async () => {
    const t = setup(() => new Promise(() => {}));
    expect(t.last()).toBe("connecting");
    expect(t.calls[0]?.[0]).toBe("https://relay.example.test/health");
    expect(t.calls[0]?.[1]?.cache).toBe("no-store");
    expect(t.calls[0]?.[1]?.method ?? "GET").toBe("GET");
  });

  it("is connected when the protocol versions match", async () => {
    const t = setup(() => json({ ok: true, protocolVersion: PROTOCOL_VERSION }));
    await flush();
    expect(t.last()).toBe("connected");
  });

  it("says please reload when the relay speaks another protocol", async () => {
    const t = setup(() => json({ ok: true, protocolVersion: PROTOCOL_VERSION + 1 }));
    await flush();
    expect(t.last()).toBe("reload");
  });

  it("says please reload when the relay is older", async () => {
    const t = setup(() => json({ ok: true, protocolVersion: PROTOCOL_VERSION - 1 }));
    await flush();
    expect(t.last()).toBe("reload");
  });

  describe("cannot connect", () => {
    it.each<[string, FetchFn]>([
      ["a network error", () => Promise.reject(new TypeError("Failed to fetch"))],
      ["a server error", () => json({ error: "boom" }, 500)],
      ["a 404", () => json({}, 404)],
      ["a body that isn't JSON", () => Promise.resolve(new Response("<html>", { status: 200 }))],
      ["an unexpected shape", () => json({ hello: "world" })],
    ])("on %s", async (_label, fetchFn) => {
      const t = setup(fetchFn);
      await flush();
      expect(t.last()).toBe("unreachable");
    });

    it("after the timeout, and aborts the request", async () => {
      let signal: AbortSignal | undefined;
      const t = setup((_url, init) => {
        signal = init?.signal ?? undefined;
        return new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted"))));
      });
      await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS - 1);
      expect(t.last()).toBe("connecting");
      await vi.advanceTimersByTimeAsync(1);
      expect(t.last()).toBe("unreachable");
      expect(signal?.aborted).toBe(true);
    });

    it("when fetch throws synchronously", async () => {
      const t = setup(() => {
        throw new TypeError("bad url");
      });
      await flush();
      expect(t.last()).toBe("unreachable");
    });
  });

  it("stop() aborts and reports nothing further", async () => {
    let resolve: (r: Response) => void = () => {};
    let signal: AbortSignal | undefined;
    const t = setup((_url, init) => {
      signal = init?.signal ?? undefined;
      return new Promise((r) => (resolve = r));
    });
    const count = t.statuses.length;
    t.stop();
    expect(signal?.aborted).toBe(true);
    resolve(new Response(JSON.stringify({ ok: true, protocolVersion: PROTOCOL_VERSION })));
    await flush();
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS);
    expect(t.statuses.length).toBe(count);
  });
});
