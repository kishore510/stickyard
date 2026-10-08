import { exports } from "cloudflare:workers";
import { createExecutionContext, env, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { MAX_SERVER_MESSAGE_BYTES, PROTOCOL_VERSION, parseMessage, serverMessageSchema, type ServerMessage } from "@stickyard/shared";
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

/**
 * The host token straight from the spec, independently of src/hostToken.ts:
 * base64url(HMAC-SHA256(key, "stickyard-host-v1:" + id)), all 32 bytes.
 */
export async function specHostToken(id: string, key = TEST_SIGNING_KEY): Promise<string> {
  const hmacKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", hmacKey, new TextEncoder().encode(`stickyard-host-v1:${id}`))));
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
      const parsed = parseMessage(String(event.data), serverMessageSchema, MAX_SERVER_MESSAGE_BYTES);
      if (!parsed.ok) throw new Error(`invalid server message: ${String(event.data).slice(0, 200)}`);
      const waiter = this.waiters.shift();
      if (waiter) waiter(parsed.value);
      else this.queue.push(parsed.value);
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
    // Made here, so a timeout's stack names the test line that waited.
    const timeout = new Error("no message");
    return new Promise((resolve, reject) => {
      const waiter = (m: ServerMessage) => {
        clearTimeout(timer);
        resolve(m);
      };
      const timer = setTimeout(() => {
        // A waiter that timed out must not swallow the next message.
        const i = this.waiters.indexOf(waiter);
        if (i !== -1) this.waiters.splice(i, 1);
        reject(timeout);
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  async request(message: unknown): Promise<ServerMessage> {
    this.send(message);
    return this.next();
  }

  /** Resolves true if nothing arrives within `ms`. A message that does arrive stays queued for next(). */
  async quiet(ms = 150): Promise<boolean> {
    if (this.queue.length > 0) return false;
    return new Promise((resolve) => {
      const waiter = (m: ServerMessage) => {
        this.queue.unshift(m);
        resolve(false);
      };
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

  /**
   * hello + join; returns the `joined` message. The notes snapshot that follows it is kept in
   * `snapshot`, the frames snapshot right after that (protocol v9) in `frames`, and the shapes
   * snapshot after that (protocol v15) in `shapes`. `key` (protocol v17) names this page's writer.
   */
  async enter(name: string, key?: string): Promise<Extract<ServerMessage, { type: "joined" }>> {
    const welcome = await this.request({ type: "hello", protocolVersion: PROTOCOL_VERSION });
    if (welcome.type !== "welcome") throw new Error(`expected welcome, got ${JSON.stringify(welcome)}`);
    // Protocol v17: the room's client key (silent brainstorm's writer) rides on join when given.
    const joined = await this.request(key === undefined ? { type: "join", name } : { type: "join", name, key });
    if (joined.type !== "joined") throw new Error(`expected joined, got ${JSON.stringify(joined)}`);
    const snapshot = await this.next();
    if (snapshot.type !== "snapshot") throw new Error(`expected snapshot, got ${JSON.stringify(snapshot)}`);
    this.snapshot = snapshot;
    const frames = await this.next();
    if (frames.type !== "framesSnapshot") throw new Error(`expected framesSnapshot, got ${JSON.stringify(frames)}`);
    this.frames = frames;
    const shapes = await this.next();
    if (shapes.type !== "shapesSnapshot") throw new Error(`expected shapesSnapshot, got ${JSON.stringify(shapes)}`);
    this.shapes = shapes;
    return joined;
  }

  snapshot: Extract<ServerMessage, { type: "snapshot" }> | null = null;
  frames: Extract<ServerMessage, { type: "framesSnapshot" }> | null = null;
  shapes: Extract<ServerMessage, { type: "shapesSnapshot" }> | null = null;
}

/**
 * Empties the batch-entries bucket (BATCH_LIMITS) of the joined socket named `name`, with its refill
 * clock an hour ahead, so the next message that carries entries is over budget however fast or slow
 * the runner is. Sending messages faster than the bucket refills can't promise that on a busy runner.
 */
export async function emptyEntryBudget(stub: DurableObjectStub, name: string): Promise<void> {
  await runInDurableObject(stub, (_r: unknown, state: DurableObjectState) => {
    for (const ws of state.getWebSockets()) {
      const att = ws.deserializeAttachment() as { participant?: { name?: string } | null; entryTokens: number; entryAt: number };
      if (att.participant?.name === name) ws.serializeAttachment({ ...att, entryTokens: 0, entryAt: Date.now() + 3_600_000 });
    }
  });
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
