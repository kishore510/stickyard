import { createHmac, randomBytes } from "node:crypto";
import {
  MAX_SERVER_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  parseMessage,
  serverMessageSchema,
  type Connector,
  type Frame,
  type Group,
  type Note,
  type ServerMessage,
  type Shape,
} from "@stickyard/shared";
import type { SocketFactory } from "../../web/src/connection/socket";
import { INITIAL_VIEW, RoomSession, type RoomView } from "../../web/src/rooms/session";
import type { ProbeResult } from "../../web/src/connection/reconnect";
import { FAKE_SIGNING_KEY, LOCAL_ORIGIN } from "./relay";
import { localTarget } from "./target";

/*
 * The load harness's clients. A `Page` is the web app's own RoomSession (web/src/rooms/session.ts:
 * the same optimistic board, pacing and reconnect rules a browser tab runs) over a Node WebSocket,
 * with every frame it receives and sends recorded. A `Raw` client speaks the protocol directly (a
 * fresh join for the relay's truth, a misbehaving socket). Fixtures are generic; nothing here is
 * a real secret.
 */

const b64url = (bytes: Buffer) => bytes.toString("base64url");

/** A room code signed with the fake key (room creation is capped at 5 a day per client, so the harness mints its own). */
export function fakeRoom(): { code: string; id: string; hostToken: string } {
  const id = b64url(randomBytes(16));
  const sig = b64url(createHmac("sha256", FAKE_SIGNING_KEY).update(`stickyard-room-v1:${id}`).digest().subarray(0, 16));
  const hostToken = b64url(createHmac("sha256", FAKE_SIGNING_KEY).update(`stickyard-host-v1:${id}`).digest());
  return { code: `${id}.${sig}`, id, hostToken };
}

/** A page's random client key (voter and writer), as the web makes one. */
export const clientKey = () => b64url(randomBytes(16));

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Counters shared by every socket of a run (what the relay would be billed for). */
export class Meter {
  opens = 0;
  inbound = 0;
  inboundBytes = 0;
  outbound = 0;
  outboundBytes = 0;
  health = 0;
  byType = new Map<string, number>();
  reset(): void {
    this.opens = this.inbound = this.inboundBytes = this.outbound = this.outboundBytes = this.health = 0;
    this.byType.clear();
  }
  /** Durable Object requests: one per socket opened, and inbound WebSocket messages at 20:1. */
  get doRequests(): number {
    return this.opens + this.inbound / 20;
  }
}

/** One recorded frame. `dir`: in = relay to client, out = client to relay. */
export interface Frame_ {
  dir: "in" | "out";
  at: number;
  raw: string;
}

export interface Recorded {
  frames: Frame_[];
}

function wsUrl(relay: string, code: string): string {
  const base = localTarget(relay);
  return `${base.protocol === "http:" ? "ws:" : base.protocol}//${base.host}/ws?room=${encodeURIComponent(code)}`;
}

/** A socket factory over Node's WebSocket, with the local dev Origin, recording into `rec` and counting into `meter`. */
export function recordingFactory(rec: Recorded, meter: Meter, live: Set<WebSocket>, opened: number[] = []): SocketFactory {
  return (url, handlers) => {
    localTarget(url);
    meter.opens++;
    opened.push(Date.now());
    const ws = new WebSocket(url, { headers: { Origin: LOCAL_ORIGIN } } as unknown as string[]);
    live.add(ws);
    ws.onopen = () => handlers.onOpen();
    ws.onmessage = (event) => {
      const raw = String(event.data);
      rec.frames.push({ dir: "in", at: Date.now(), raw });
      meter.outbound++;
      meter.outboundBytes += Buffer.byteLength(raw);
      handlers.onMessage(raw);
    };
    ws.onclose = (event) => {
      live.delete(ws);
      handlers.onClose(event.code);
    };
    ws.onerror = () => handlers.onError();
    return {
      send: (data) => {
        rec.frames.push({ dir: "out", at: Date.now(), raw: data });
        meter.inbound++;
        meter.inboundBytes += Buffer.byteLength(data);
        const type = /"type":"([A-Za-z_]+)"/.exec(data)?.[1] ?? "?";
        meter.byType.set(type, (meter.byType.get(type) ?? 0) + 1);
        ws.send(data);
      },
      close: () => ws.close(),
    };
  };
}

export interface PageOptions {
  relay: string;
  code: string;
  name: string;
  meter: Meter;
  hostToken?: string;
  key?: string;
}

/** A simulated browser tab: the web's RoomSession, recorded. */
export class Page implements Recorded {
  readonly frames: Frame_[] = [];
  readonly session: RoomSession;
  readonly key: string;
  view: RoomView = INITIAL_VIEW;
  readonly sockets = new Set<WebSocket>();
  /** When each socket was opened (every try counts: one Worker and one Durable Object request each). */
  readonly opens: number[] = [];
  private listeners: (() => void)[] = [];

  constructor(readonly options: PageOptions) {
    this.key = options.key ?? clientKey();
    const relay = localTarget(options.relay);
    this.session = new RoomSession({
      url: wsUrl(options.relay, options.code),
      createSocket: recordingFactory(this, options.meter, this.sockets, this.opens),
      checkCode: async () => "valid",
      checkHealth: async (): Promise<ProbeResult> => {
        options.meter.health++;
        try {
          const res = await fetch(new URL("/health", relay));
          if (!res.ok) return "down";
          const body = (await res.json()) as { protocolVersion?: number };
          return body.protocolVersion === PROTOCOL_VERSION ? "ok" : "reload";
        } catch {
          return "down";
        }
      },
      onChange: (view) => {
        this.view = view;
        for (const l of this.listeners.splice(0)) l();
      },
      hostToken: () => options.hostToken ?? null,
      voterKey: () => this.key,
    });
  }

  get name(): string {
    return this.options.name;
  }

  /** Waits until `ok(view)` holds, or throws after `ms`. */
  async until(ok: (view: RoomView) => boolean, ms = 15_000, what = "condition"): Promise<RoomView> {
    const end = Date.now() + ms;
    while (!ok(this.view)) {
      if (Date.now() > end) throw new Error(`${this.name}: timed out waiting for ${what} (status ${this.view.status})`);
      await Promise.race([new Promise<void>((r) => this.listeners.push(r)), sleep(100)]);
    }
    return this.view;
  }

  async join(): Promise<void> {
    this.session.join(this.options.name);
    await this.until((v) => v.status === "joined" && v.synced, 20_000, "joined");
  }

  /** Kills the socket under the session (as a deploy or a network drop would); the session reconnects on its own. */
  drop(): void {
    for (const ws of this.sockets) ws.close(4000, "dropped by harness");
  }

  close(): void {
    this.session.close();
  }

  /** Inbound messages, parsed (invalid ones throw: every message must validate). */
  inbound(since = 0): ServerMessage[] {
    return this.frames.filter((f) => f.dir === "in" && f.at >= since).map((f) => parseServer(f.raw));
  }
}

export function parseServer(raw: string): ServerMessage {
  const parsed = parseMessage(raw, serverMessageSchema, MAX_SERVER_MESSAGE_BYTES);
  if (!parsed.ok) throw new Error(`server message failed the shared schema: ${raw.slice(0, 200)}`);
  return parsed.value;
}

/** A plain protocol client: a fresh join (the relay's truth) or a misbehaving socket. */
export class Raw implements Recorded {
  readonly frames: Frame_[] = [];
  private ws: WebSocket | null = null;
  private waiters: { ok: (m: ServerMessage) => boolean; done: (m: ServerMessage) => void }[] = [];
  readonly queue: ServerMessage[] = [];
  closed: number | null = null;

  constructor(
    readonly relay: string,
    readonly code: string,
    readonly meter: Meter,
  ) {}

  async open(): Promise<void> {
    this.meter.opens++;
    const ws = new WebSocket(wsUrl(this.relay, this.code), { headers: { Origin: LOCAL_ORIGIN } } as unknown as string[]);
    this.ws = ws;
    ws.onmessage = (event) => {
      const raw = String(event.data);
      this.frames.push({ dir: "in", at: Date.now(), raw });
      this.meter.outbound++;
      this.meter.outboundBytes += Buffer.byteLength(raw);
      const m = parseServer(raw);
      const i = this.waiters.findIndex((w) => w.ok(m));
      if (i >= 0) this.waiters.splice(i, 1)[0]?.done(m);
      else this.queue.push(m);
    };
    ws.onclose = (event) => {
      this.closed = event.code;
    };
    await new Promise<void>((ok, fail) => {
      ws.onopen = () => ok();
      ws.onerror = () => fail(new Error("raw socket failed to open"));
    });
  }

  send(message: unknown): void {
    const data = typeof message === "string" ? message : JSON.stringify(message);
    this.frames.push({ dir: "out", at: Date.now(), raw: data });
    this.meter.inbound++;
    this.meter.inboundBytes += Buffer.byteLength(data);
    this.ws?.send(data);
  }

  /** The next message of `type` (queued or arriving within `ms`). */
  next<T extends ServerMessage["type"]>(type: T, ms = 10_000): Promise<Extract<ServerMessage, { type: T }>> {
    const i = this.queue.findIndex((m) => m.type === type);
    if (i >= 0) return Promise.resolve(this.queue.splice(i, 1)[0] as Extract<ServerMessage, { type: T }>);
    return new Promise((ok, fail) => {
      const waiter = { ok: (m: ServerMessage) => m.type === type, done: (m: ServerMessage) => ok(m as Extract<ServerMessage, { type: T }>) };
      this.waiters.push(waiter);
      setTimeout(() => {
        const j = this.waiters.indexOf(waiter);
        if (j >= 0) {
          this.waiters.splice(j, 1);
          fail(new Error(`raw client: no ${type} within ${ms} ms`));
        }
      }, ms);
    });
  }

  /** hello + join, then the six join-step snapshots: the relay's board as a fresh joiner gets it. */
  async enter(name: string, key?: string): Promise<{ board: CanonBoard; bytes: number[]; ms: number }> {
    const started = Date.now();
    const from = this.frames.length;
    this.send({ type: "hello", protocolVersion: PROTOCOL_VERSION });
    await this.next("welcome");
    this.send(key ? { type: "join", name, key } : { type: "join", name });
    await this.next("joined");
    const notes = await this.next("snapshot");
    const frames = await this.next("framesSnapshot");
    const shapes = await this.next("shapesSnapshot");
    const reactions = await this.next("reactionsSnapshot");
    const connectors = await this.next("connectorsSnapshot");
    const groups = await this.next("groupsSnapshot");
    const ms = Date.now() - started;
    const bytes = this.frames
      .slice(from)
      .filter((f) => f.dir === "in")
      .map((f) => Buffer.byteLength(f.raw));
    const counts = new Map<string, Map<string, number>>();
    for (const c of reactions.counts) {
      const m = counts.get(c.noteId) ?? new Map<string, number>();
      m.set(c.key, c.count);
      counts.set(c.noteId, m);
    }
    return { board: canon(notes.notes, frames.frames, shapes.shapes, connectors.connectors, groups.groups, counts), bytes, ms };
  }

  close(code = 1000): void {
    this.ws?.close(code);
  }
}

/** A board reduced to what everyone must agree on: every item by id, in id order, members sorted. */
export interface CanonBoard {
  notes: Note[];
  frames: Frame[];
  shapes: Shape[];
  connectors: Connector[];
  groups: Group[];
  reactions: [string, [string, number][]][];
}

const byId = <T extends { id: string }>(items: readonly T[]) => [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

export function canon(
  notes: readonly Note[],
  frames: readonly Frame[],
  shapes: readonly Shape[],
  connectors: readonly Connector[],
  groups: readonly Group[],
  reactions: ReadonlyMap<string, ReadonlyMap<string, number>>,
): CanonBoard {
  return {
    notes: byId(notes),
    frames: byId(frames),
    shapes: byId(shapes),
    connectors: byId(connectors),
    groups: byId(groups).map((g) => ({ ...g, members: [...g.members].sort() })),
    reactions: [...reactions.entries()]
      .map(([note, keys]): [string, [string, number][]] => [note, [...keys.entries()].filter(([, n]) => n > 0).sort()])
      .filter(([, keys]) => keys.length > 0)
      .sort(),
  };
}

/** What a page shows, as a CanonBoard, plus anything still pending (which must be nothing once settled). */
export function pageBoard(view: RoomView): { board: CanonBoard; pending: string[] } {
  const b = view.board;
  const pending: string[] = [];
  const shown = <E extends { confirmed: unknown; clientRef: string | null }>(kind: string, entries: readonly E[], item: (e: E) => { id: string }) => {
    for (const e of entries) {
      if (e.clientRef !== null || e.confirmed === null) pending.push(`${kind} ${item(e).id} unconfirmed`);
      else if (JSON.stringify(e.confirmed) !== JSON.stringify(item(e))) pending.push(`${kind} ${item(e).id} differs from confirmed`);
    }
  };
  shown("note", b.notes, (e) => e.note);
  shown("frame", b.frames, (e) => e.frame);
  shown("shape", b.shapes, (e) => e.shape);
  shown("connector", b.connectors, (e) => e.connector);
  shown("group", b.groups, (e) => e.group);
  for (const [kind, list] of [
    ["note", b.removed],
    ["frame", b.framesRemoved],
    ["shape", b.shapesRemoved],
    ["connector", b.connectorsRemoved],
    ["group", b.groupsRemoved],
  ] as const) {
    if (list.length > 0) pending.push(`${list.length} ${kind} deletes unconfirmed`);
  }
  return {
    board: canon(
      b.notes.map((e) => e.note),
      b.frames.map((e) => e.frame),
      b.shapes.map((e) => e.shape),
      b.connectors.map((e) => e.connector),
      b.groups.map((e) => e.group),
      view.reactionCounts,
    ),
    pending,
  };
}

/** Human-readable differences between two boards (empty: identical). */
export function diffBoards(a: CanonBoard, b: CanonBoard, label: string): string[] {
  const out: string[] = [];
  for (const kind of ["notes", "frames", "shapes", "connectors", "groups"] as const) {
    const left = new Map<string, unknown>(a[kind].map((x) => [x.id, x]));
    const right = new Map<string, unknown>(b[kind].map((x) => [x.id, x]));
    for (const [id, x] of left) {
      const y = right.get(id);
      if (y === undefined) out.push(`${label}: ${kind} ${id} only on the page`);
      else if (JSON.stringify(x) !== JSON.stringify(y)) out.push(`${label}: ${kind} ${id} differs: page ${JSON.stringify(x)} relay ${JSON.stringify(y)}`);
    }
    for (const id of right.keys()) if (!left.has(id)) out.push(`${label}: ${kind} ${id} missing on the page`);
  }
  if (JSON.stringify(a.reactions) !== JSON.stringify(b.reactions)) out.push(`${label}: reaction counts differ`);
  return out;
}

/** Waits until no page has received or sent anything for `quietMs` (and at most `ms`). */
export async function settle(pages: readonly Recorded[], quietMs = 1500, ms = 60_000): Promise<void> {
  const end = Date.now() + ms;
  for (;;) {
    const last = Math.max(0, ...pages.map((p) => p.frames.at(-1)?.at ?? 0));
    if (Date.now() - last >= quietMs) return;
    if (Date.now() > end) throw new Error("the room never went quiet");
    await sleep(200);
  }
}

/** A small seeded random generator, so a failing run can be repeated (LOAD_SEED). */
export function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}
