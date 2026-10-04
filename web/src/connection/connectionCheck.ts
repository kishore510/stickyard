import { PROTOCOL_VERSION, healthResponseSchema } from "@stickyard/shared";
import type { ProbeResult } from "./reconnect";

/*
 * The start page's status line: one plain GET /health (no WebSocket, no Durable Object),
 * comparing the relay's protocol version with this page's.
 */

export type CheckStatus = "connecting" | "connected" | "reload" | "unreachable";

export const CONNECT_TIMEOUT_MS = 10_000;

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface CheckOptions {
  url: string;
  fetch: FetchFn;
  onStatus(status: CheckStatus): void;
}

/** Starts the check and reports its states. Returns a stop function. */
export function startConnectionCheck({ url, fetch, onStatus }: CheckOptions): () => void {
  const controller = new AbortController();
  let done = false;

  const finish = (status: CheckStatus) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    onStatus(status);
  };

  onStatus("connecting");
  const timer = setTimeout(() => {
    finish("unreachable");
    controller.abort();
  }, CONNECT_TIMEOUT_MS);

  const run = async (): Promise<CheckStatus> => {
    const res = await fetch(url, { cache: "no-store", signal: controller.signal });
    if (!res.ok) return "unreachable";
    const parsed = healthResponseSchema.safeParse(await res.json());
    if (!parsed.success) return "unreachable";
    return parsed.data.protocolVersion === PROTOCOL_VERSION ? "connected" : "reload";
  };

  (async () => {
    try {
      finish(await run());
    } catch {
      finish("unreachable");
    }
  })();

  return () => {
    done = true;
    clearTimeout(timer);
    controller.abort();
  };
}

/**
 * One GET /health while reconnecting (no WebSocket, no Durable Object): "ok" when the relay answers
 * with this page's protocol, "reload" for another protocol, "down" for anything else. When the free
 * plan's daily limit is hit, Cloudflare answers with its own error page without this app's CORS
 * headers, so the browser only sees a failed fetch: the same as a relay that can't be reached.
 */
export async function probeHealth(url: string, fetchFn: FetchFn, timeoutMs: number = CONNECT_TIMEOUT_MS): Promise<ProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, { cache: "no-store", credentials: "omit", signal: controller.signal });
    if (!res.ok) return "down";
    const parsed = healthResponseSchema.safeParse(await res.json());
    if (!parsed.success) return "down";
    return parsed.data.protocolVersion === PROTOCOL_VERSION ? "ok" : "reload";
  } catch {
    return "down";
  } finally {
    clearTimeout(timer);
  }
}
