/**
 * Where the relay Worker lives. The one place to change it.
 * Override with VITE_WORKER_URL (e.g. in web/.env.local). Otherwise dev builds use a
 * local `wrangler dev`, and production builds use the deployed workers.dev address.
 */
const DEPLOYED_WORKER_URL = "https://stickyard.kishore510.workers.dev";
const LOCAL_WORKER_URL = "http://127.0.0.1:8787";

const fromEnv: string | undefined = import.meta.env.VITE_WORKER_URL;

export const WORKER_URL: string = fromEnv || (import.meta.env.DEV ? LOCAL_WORKER_URL : DEPLOYED_WORKER_URL);

/** http(s)://host + code -> ws(s)://host/ws?room=<code> */
export function toWebSocketUrl(workerUrl: string, code: string): string {
  const url = new URL("/ws", workerUrl);
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  url.searchParams.set("room", code);
  return url.toString();
}

/** The relay's GET /health, used for the start page's status line. */
export function healthUrl(workerUrl: string): string {
  return new URL("/health", workerUrl).toString();
}

/** A relay HTTP endpoint, e.g. apiUrl(WORKER_URL, "/rooms"). */
export function apiUrl(workerUrl: string, path: string): URL {
  return new URL(path, workerUrl);
}
