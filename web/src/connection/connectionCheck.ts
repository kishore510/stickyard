import { PROTOCOL_VERSION, healthResponseSchema } from "@stickyard/shared";

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
