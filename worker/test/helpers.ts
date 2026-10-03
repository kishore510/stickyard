import { exports } from "cloudflare:workers";
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { serverMessageSchema, type ServerMessage } from "@stickyard/shared";
import worker from "../src/index";
import type { WorkerEnv } from "../src/env";

/** Matches ALLOWED_ORIGINS in wrangler.jsonc. */
export const PAGES_ORIGIN = "https://kishore510.github.io";
/** Fake values from vitest.config.ts. */
export const TEST_PASSCODE = "test-passcode";
export const TEST_SIGNING_KEY = "test-signing-key-not-a-real-secret";
export const BASE = "https://relay.example.test";

export const testEnv = env as WorkerEnv;

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

/**
 * Builds a room code straight from the spec, independently of src/roomCode.ts:
 * id = 16 random bytes; sig = first 16 bytes of HMAC-SHA256(key, "stickyard-room-v1:" + id); base64url.
 */
export async function specRoomCode(key = TEST_SIGNING_KEY, id?: string): Promise<{ code: string; id: string }> {
  const roomId = id ?? b64url(crypto.getRandomValues(new Uint8Array(16)));
  const hmacKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", hmacKey, new TextEncoder().encode(`stickyard-room-v1:${roomId}`)));
  return { code: `${roomId}.${b64url(mac.slice(0, 16))}`, id: roomId };
}

/** Calls the Worker's fetch handler directly, with an optional env override. */
export async function callWorker(request: Request, overrides: Partial<WorkerEnv> = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(request as Parameters<typeof worker.fetch>[0], { ...testEnv, ...overrides }, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

export function wsRequest(path: string, origin: string | null = PAGES_ORIGIN, upgrade = true): Request {
  const headers = new Headers();
  if (upgrade) headers.set("Upgrade", "websocket");
  if (origin !== null) headers.set("Origin", origin);
  return new Request(`${BASE}${path}`, { headers });
}

export const roomPath = (code: string) => `/ws?room=${encodeURIComponent(code)}`;

/** A WebSocket client for tests: queues server messages and validates each against the schema. */
export class TestClient {
  private queue: ServerMessage[] = [];
  private waiters: ((m: ServerMessage) => void)[] = [];
  closeCode: number | null = null;
  private closeWaiters: ((code: number) => void)[] = [];

  constructor(readonly ws: WebSocket) {
    ws.addEventListener("message", (event) => {
      const parsed = serverMessageSchema.safeParse(JSON.parse(String(event.data)));
      if (!parsed.success) throw new Error(`invalid server message: ${String(event.data)}`);
      const waiter = this.waiters.shift();
      if (waiter) waiter(parsed.data);
      else this.queue.push(parsed.data);
    });
    ws.addEventListener("close", (event) => {
      this.closeCode = event.code;
      for (const w of this.closeWaiters.splice(0)) w(event.code);
    });
  }

  static async open(code: string, origin = PAGES_ORIGIN): Promise<TestClient> {
    return TestClient.openPath(roomPath(code), origin);
  }

  static async openPath(path: string, origin = PAGES_ORIGIN): Promise<TestClient> {
    const res = await exports.default.fetch(wsRequest(path, origin));
    if (res.status !== 101 || !res.webSocket) throw new Error(`expected 101, got ${res.status}`);
    res.webSocket.accept();
    return new TestClient(res.webSocket);
  }

  send(message: unknown): void {
    this.ws.send(typeof message === "string" || message instanceof ArrayBuffer ? message : JSON.stringify(message));
  }

  next(timeoutMs = 2000): Promise<ServerMessage> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no message")), timeoutMs);
      this.waiters.push((m) => {
        clearTimeout(timer);
        resolve(m);
      });
    });
  }

  async request(message: unknown): Promise<ServerMessage> {
    this.send(message);
    return this.next();
  }

  /** Resolves true if nothing arrives within `ms`. */
  async quiet(ms = 150): Promise<boolean> {
    if (this.queue.length > 0) return false;
    return new Promise((resolve) => {
      const waiter = () => resolve(false);
      this.waiters.push(waiter);
      setTimeout(() => {
        const i = this.waiters.indexOf(waiter);
        if (i !== -1) {
          this.waiters.splice(i, 1);
          resolve(true);
        }
      }, ms);
    });
  }

  waitClose(timeoutMs = 3000): Promise<number> {
    if (this.closeCode !== null) return Promise.resolve(this.closeCode);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("not closed")), timeoutMs);
      this.closeWaiters.push((code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
  }

  close(): void {
    this.ws.close(1000, "bye");
  }

  /** hello + join; returns the `joined` message. */
  async enter(name: string): Promise<Extract<ServerMessage, { type: "joined" }>> {
    const welcome = await this.request({ type: "hello", protocolVersion: 2 });
    if (welcome.type !== "welcome") throw new Error(`expected welcome, got ${JSON.stringify(welcome)}`);
    const joined = await this.request({ type: "join", name });
    if (joined.type !== "joined") throw new Error(`expected joined, got ${JSON.stringify(joined)}`);
    return joined;
  }
}

/** Waits until `client` gets a message of `type`, skipping others. */
export async function nextOfType<T extends ServerMessage["type"]>(
  client: TestClient,
  type: T,
): Promise<Extract<ServerMessage, { type: T }>> {
  for (;;) {
    const m = await client.next();
    if (m.type === type) return m as Extract<ServerMessage, { type: T }>;
  }
}

export function createRequest(
  body: unknown,
  { origin = PAGES_ORIGIN, ip = "198.51.100.1" }: { origin?: string | null; ip?: string } = {},
): Request {
  const headers = new Headers({ "Content-Type": "application/json", "CF-Connecting-IP": ip });
  if (origin !== null) headers.set("Origin", origin);
  return new Request(`${BASE}/rooms`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** A fresh random client IP (IPv6 documentation range), so per-client limits don't leak between tests. */
export const freshIp = () =>
  `2001:db8::${Array.from(crypto.getRandomValues(new Uint16Array(3)), (n) => n.toString(16)).join(":")}`;
