/**
 * Where the relay Worker lives. The one place to change it.
 * Override with VITE_WORKER_URL (e.g. in web/.env.local). Otherwise dev builds use a
 * local `wrangler dev`, and production builds use the deployed workers.dev address.
 */
const DEPLOYED_WORKER_URL = "https://stickyard.kishore510.workers.dev";
const LOCAL_WORKER_URL = "http://127.0.0.1:8787";

const fromEnv: string | undefined = import.meta.env.VITE_WORKER_URL;

export const WORKER_URL: string = fromEnv || (import.meta.env.DEV ? LOCAL_WORKER_URL : DEPLOYED_WORKER_URL);

/** http(s)://host -> ws(s)://host/ws */
export function toWebSocketUrl(workerUrl: string): string {
  const url = new URL("/ws", workerUrl);
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  return url.toString();
}
