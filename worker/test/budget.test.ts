/// <reference types="vite/client" />
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { CONNECTOR_DEFAULTS, FRAME_DEFAULTS, PROTOCOL_VERSION, REACTION_KEYS, type ServerMessage } from "@stickyard/shared";
import type { Room } from "../src/room";
import { NoteStore } from "../src/noteStore";
import { BATCH_LIMITS, BRING_LIMITS, CONNECTOR_LIMITS, GROUP_LIMITS, REACTION_LIMITS, SOCKET_LIMITS, VIEWPORT_LIMITS } from "../src/limits";
import { TestClient, specHostToken, specRoomCode } from "./helpers";

/*
 * Hardening (v0.39.1): the budget of a scripted two-hour session with 12 people, measured on the
 * real Durable Object (miniflare, the runtime `wrangler dev` uses). Every stored action of the
 * session is sent for real and its rows counted (rowsWritten, and rows read by wrapping sql.exec);
 * live drags, cursors and viewports are sampled to show they write nothing, and their volume is
 * counted from the web's send rates. Rate buckets are refilled between actions so two hours fit in
 * seconds: refills change timing, never rows. The numbers feed docs/LIMITS.md "Hardening findings".
 * Generic fixtures, fake keys.
 */

type Stub = DurableObjectStub;

/** The session, as counts. Live messages are the web's rates times how long people do each thing. */
export const SESSION = {
  people: 12,
  hours: 2,
  reconnects: 24,
  notes: 110,
  sealedNotes: 40,
  textEdits: 300,
  styleEdits: 60,
  drags: 400,
  resizes: 40,
  groupDrags: 20,
  arranges: 2,
  orders: 20,
  templateFrames: 4,
  frames: 4,
  frameEdits: 8,
  frameMoves: 20,
  frameResizes: 4,
  shapes: 15,
  shapeEdits: 30,
  shapeMoves: 20,
  arrows: 30,
  arrowUpdates: 20,
  arrowDeletes: 5,
  groups: 10,
  groupUpdates: 10,
  groupMemberChanges: 10,
  groupDeletes: 3,
  reactionsOn: 400,
  reactionsOff: 50,
  voteRounds: 2,
  votesPerPersonPerRound: 5,
  voteChangesPerRound: 20,
  sealedEdits: 20,
  deletes: 30,
  chat: 60,
  timerStarts: 6,
  timerStops: 2,
  locks: 2,
  follows: 11,
  brings: 10,
  /** Live messages (not stored), from the web's rates: a drag ~1 s at 20/s, a resize ~0.5 s at 20/s, a group or frame drag ~1 s at 10/s. */
  liveDragMessages: 400 * 20 + 40 * 10 + 20 * 10 + 20 * 20 + 20 * 20,
  /** Follow: the facilitator followed for 30 minutes, panning a third of it, at 5 a second. */
  viewports: 30 * 60 * (1 / 3) * 5,
  /** Cursors: 8 of 12 on a mouse, moving 15% of the time, at 10 a second. Phones and touch send none. */
  cursors: 8 * 2 * 3600 * 0.15 * 10,
} as const;

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
const newKey = () => b64url(crypto.getRandomValues(new Uint8Array(16)));

/** Every message sent, by type, and sockets opened. */
const sent = new Map<string, number>();
let opens = 0;
const count = (type: string, n = 1) => sent.set(type, (sent.get(type) ?? 0) + n);

class Person {
  client!: TestClient;
  readonly key = newKey();
  constructor(
    readonly name: string,
    readonly code: string,
  ) {}

  async enter(token?: string): Promise<void> {
    opens++;
    this.client = await TestClient.open(this.code);
    count("hello");
    count("join");
    await this.client.enter(this.name, this.key);
    await this.act({ type: "claimVoter", key: this.key }, "voterGranted");
    if (token) await this.act({ type: "claimHost", token }, "hostGranted");
  }

  /** Sends and waits for the reply of `type` (skipping others' broadcasts); a refusal fails the test. */
  async act<T extends ServerMessage["type"]>(message: { type: string } & Record<string, unknown>, type: T, ok?: (m: Extract<ServerMessage, { type: T }>) => boolean): Promise<Extract<ServerMessage, { type: T }>> {
    // Others' broadcasts queued here earlier are not this reply: drop them, and match the reply by what it names.
    (this.client as unknown as { queue: unknown[] }).queue.length = 0;
    const marker = [message.clientRef, message.id, message.noteId].find((v): v is string => typeof v === "string");
    const matches = ok ?? ((m: ServerMessage) => marker === undefined || JSON.stringify(m).includes(marker));
    count(message.type);
    this.client.send(message);
    for (;;) {
      const m = await this.client.next(5000).catch(() => {
        throw new Error(`${this.name}: no ${type} after ${message.type} (socket closed: ${this.client.closeCode})`);
      });
      if (m.type === "error" && (marker === undefined || JSON.stringify(m).includes(marker) || !("noteId" in m || "clientRef" in m || "frameId" in m))) throw new Error(`${message.type} refused: ${m.code}`);
      if (m.type === type && matches(m as Extract<ServerMessage, { type: T }>)) return m as Extract<ServerMessage, { type: T }>;
    }
  }

  /** Waits until everything this socket sent has been handled (a chat round trip, not counted). */
  async sync(): Promise<void> {
    this.client.send({ type: "say", text: "sync" });
    for (;;) {
      const m = await this.client.next(5000);
      if (m.type === "echo" && m.text === "sync") return;
    }
  }

  /** Sends without waiting (live messages, which nobody answers to the sender). */
  fire(message: { type: string } & Record<string, unknown>): void {
    count(message.type);
    this.client.send(message);
  }
}

/** Refills every rate bucket on every socket: the compressed session never earns rate_limited. */
async function refill(stub: Stub): Promise<void> {
  await runInDurableObject(stub, (_r: unknown, state: DurableObjectState) => {
    const now = Date.now();
    for (const ws of state.getWebSockets()) {
      const att = ws.deserializeAttachment() as Record<string, unknown> | null;
      if (!att) continue;
      ws.serializeAttachment({
        ...att,
        tokens: SOCKET_LIMITS.burst,
        at: now,
        entryTokens: BATCH_LIMITS.entriesBurst,
        entryAt: now,
        reactTokens: REACTION_LIMITS.burst,
        reactAt: now,
        connectorTokens: CONNECTOR_LIMITS.burst,
        connectorAt: now,
        groupTokens: GROUP_LIMITS.burst,
        groupAt: now,
        groupMemberTokens: GROUP_LIMITS.membersBurst,
        groupMemberAt: now,
        viewTokens: VIEWPORT_LIMITS.burst,
        viewAt: now,
        bringTokens: BRING_LIMITS.burst,
        bringAt: now,
      });
    }
  });
}

/** Counts rows read by every sql.exec from now on (each cursor's rowsRead, summed when asked). */
async function watchReads(stub: Stub): Promise<() => Promise<number>> {
  await runInDurableObject(stub, (_r: unknown, state: DurableObjectState) => {
    const holder = globalThis as { __cursors?: { rowsRead: number }[] };
    holder.__cursors = [];
    const sql = state.storage.sql as unknown as Record<string, unknown>;
    const original = sql.exec as (...a: unknown[]) => { rowsRead: number };
    sql.exec = (...args: unknown[]) => {
      const cursor = original.apply(state.storage.sql, args);
      holder.__cursors?.push(cursor);
      return cursor;
    };
  });
  return () => runInDurableObject(stub, () => ((globalThis as { __cursors?: { rowsRead: number }[] }).__cursors ?? []).reduce((n, c) => n + c.rowsRead, 0));
}

describe("budget: a scripted two-hour session with 12 people", () => {
  it("counts messages, rows written and rows read", { timeout: 180_000 }, async () => {
    const { code, id } = await specRoomCode();
    const token = await specHostToken(id);
    const stub = env.ROOM.get(env.ROOM.idFromName(id));
    const people = Array.from({ length: SESSION.people }, (_, i) => new Person(`Person ${i + 1}`, code));
    const host = people[0] as Person;
    const nth = (i: number) => people[i % people.length] as Person;
    const reads = await (async () => {
      await host.enter(token);
      return watchReads(stub);
    })();
    for (const p of people.slice(1)) await p.enter();
    const rows = () => runInDurableObject(stub, (r: Room) => r.rowsWritten);
    let tick = 0;
    const paced = async () => {
      if (++tick % 20 === 0) await refill(stub);
    };

    // A template (one itemsAdd of frames), then notes.
    await host.act({ type: "itemsAdd", clientRef: "tpl", frames: Array.from({ length: SESSION.templateFrames }, (_, i) => ({ ref: `t${i}`, x: i * 700, y: 0, w: 640, h: 400, title: `Column ${i + 1}`, color: "neutral", ...FRAME_DEFAULTS })) }, "itemsAdded");
    const notes: string[] = [];
    for (let i = 0; i < SESSION.notes; i++) {
      const m = await nth(i).act({ type: "noteAdd", clientRef: `n${i}`, x: (i % 20) * 300, y: 500 + Math.floor(i / 20) * 300, color: "yellow", text: `Idea ${i + 1}` }, "noteAdded", (m) => m.clientRef === `n${i}`);
      notes.push(m.note.id);
      await paced();
    }
    const note = (i: number) => notes[i % notes.length] as string;
    for (let i = 0; i < SESSION.textEdits; i++) {
      await nth(i).act({ type: "noteEdit", id: note(i), text: `Idea ${i % notes.length} v${i}` }, "noteUpdated");
      await paced();
    }
    for (let i = 0; i < SESSION.styleEdits; i++) {
      await nth(i).act({ type: "noteEdit", id: note(i), color: i % 2 ? "pink" : "blue" }, "noteUpdated");
      await paced();
    }
    // Drags, resizes and group drags: one live message each is sampled (they must write nothing), then the drop.
    const beforeLive = await rows();
    for (let i = 0; i < SESSION.drags; i++) nth(i).fire({ type: "noteMove", id: note(i), x: 100 + (i % 50), y: 100, final: false });
    for (let i = 0; i < 200; i++) nth(i).fire({ type: "cursor", x: i * 10, y: 100 });
    for (const p of people) await p.sync();
    await refill(stub);
    const liveRows = (await rows()) - beforeLive;
    for (let i = 0; i < SESSION.drags; i++) {
      await nth(i).act({ type: "noteMove", id: note(i), x: (i * 37) % 6000, y: 600 + ((i * 53) % 3000), final: true }, "noteMoved", (m) => m.final);
      await paced();
    }
    for (let i = 0; i < SESSION.resizes; i++) {
      await nth(i).act({ type: "noteResize", id: note(i), x: (i * 37) % 6000, y: 600, w: 200 + (i % 5) * 10, h: 200, final: true }, "noteResized", (m) => m.final);
      await paced();
    }
    for (let i = 0; i < SESSION.groupDrags; i++) {
      const ops = [0, 1, 2, 3, 4].map((k) => ({ op: "move", id: note(i * 5 + k), x: 1000 + i * 10 + k * 170, y: 3000 }));
      await nth(i).act({ type: "noteBatch", ops, final: true }, "notesBatchApplied", (m) => m.final);
      await paced();
    }
    for (let a = 0; a < SESSION.arranges; a++) {
      for (let i = 0; i < notes.length; i += 50) {
        const ops = notes.slice(i, i + 50).map((n, k) => ({ op: "move", id: n, x: ((i + k) % 20) * 200 + a * 7, y: 400 + Math.floor((i + k) / 20) * 200 }));
        await host.act({ type: "noteBatch", ops, final: true }, "notesBatchApplied", (m) => m.final);
        await refill(stub);
      }
    }
    for (let i = 0; i < SESSION.orders; i++) {
      await nth(i).act({ type: "notesOrder", ids: [note(i * 3)], action: i % 2 ? "back" : "front" }, "notesOrdered");
      await paced();
    }

    // Frames and shapes.
    const frames: string[] = [];
    for (let i = 0; i < SESSION.frames; i++) frames.push((await nth(i).act({ type: "frameAdd", clientRef: `f${i}`, x: i * 700, y: 2000, color: "blue", title: `Theme ${i + 1}` }, "frameAdded", (m) => m.clientRef === `f${i}`)).frame.id);
    for (let i = 0; i < SESSION.frameEdits; i++) await nth(i).act({ type: "frameEdit", id: frames[i % frames.length], title: `Theme ${i} renamed` }, "frameUpdated");
    for (let i = 0; i < SESSION.frameMoves; i++) {
      await nth(i).act({ type: "frameMove", id: frames[i % frames.length], x: (i % 4) * 700 + (i % 3) * 20, y: 2000 + (i % 2) * 30, final: true, noteIds: [note(i), note(i + 1), note(i + 2)] }, "frameMoved", (m) => m.final);
      await paced();
    }
    for (let i = 0; i < SESSION.frameResizes; i++) await nth(i).act({ type: "frameResize", id: frames[i % frames.length], x: i * 700, y: 2000, w: 700, h: 500 + i, final: true }, "frameResized", (m) => m.final);
    const shapes: string[] = [];
    for (let i = 0; i < SESSION.shapes; i++) {
      shapes.push((await nth(i).act({ type: "shapeAdd", clientRef: `s${i}`, kind: "rect", x: i * 300, y: 3500 }, "shapeAdded", (m) => m.clientRef === `s${i}`)).shape.id);
      await paced();
    }
    for (let i = 0; i < SESSION.shapeEdits; i++) {
      await nth(i).act({ type: "shapeEdit", id: shapes[i % shapes.length], text: `Step ${i}` }, "shapeUpdated");
      await paced();
    }
    for (let i = 0; i < SESSION.shapeMoves; i++) {
      await nth(i).act({ type: "shapeMove", id: shapes[i % shapes.length], x: i * 300 + 5, y: 3520, final: true }, "shapeMoved", (m) => m.final);
      await paced();
    }

    // Arrows and groups.
    const arrows: string[] = [];
    for (let i = 0; i < SESSION.arrows; i++) {
      arrows.push((await nth(i).act({ type: "connectorAdd", clientRef: `a${i}`, start: { item: note(i), anchor: "left" }, end: { item: note(i + 40), anchor: "right" }, ...CONNECTOR_DEFAULTS }, "connectorAdded", (m) => m.clientRef === `a${i}`)).connector.id);
      await paced();
    }
    for (let i = 0; i < SESSION.arrowUpdates; i++) await nth(i).act({ type: "connectorUpdate", id: arrows[i], dash: i % 2 ? "dashed" : "dotted" }, "connectorUpdated");
    for (let i = 0; i < SESSION.arrowDeletes; i++) await nth(i).act({ type: "connectorDelete", id: arrows[arrows.length - 1 - i] }, "connectorDeleted");
    await refill(stub);
    const groups: string[] = [];
    for (let i = 0; i < SESSION.groups; i++) groups.push((await nth(i).act({ type: "groupCreate", clientRef: `g${i}`, label: `Cluster ${i + 1}`, color: "green", members: [note(60 + i * 3), note(61 + i * 3), note(62 + i * 3)] }, "groupCreated", (m) => m.clientRef === `g${i}`)).group.id);
    await refill(stub);
    for (let i = 0; i < SESSION.groupUpdates; i++) await nth(i).act({ type: "groupUpdate", id: groups[i], label: `Cluster ${i + 1} (agreed)` }, "groupUpdated");
    await refill(stub);
    for (let i = 0; i < SESSION.groupMemberChanges; i++) await nth(i).act({ type: "groupMembers", id: groups[i], add: [note(95 + i)], remove: [] }, "groupUpdated");
    for (let i = 0; i < SESSION.groupDeletes; i++) await nth(i).act({ type: "groupDelete", id: groups[i] }, "groupDeleted");

    // Reactions.
    for (let i = 0; i < SESSION.reactionsOn; i++) {
      const p = nth(i);
      await p.act({ type: "reactionSet", noteId: note(Math.floor(i / 12) * 3 + (i % 3)), key: REACTION_KEYS[i % REACTION_KEYS.length], on: true }, "reactionMine");
      await paced();
    }
    for (let i = 0; i < SESSION.reactionsOff; i++) {
      await nth(i).act({ type: "reactionSet", noteId: note(Math.floor(i / 12) * 3 + (i % 3)), key: REACTION_KEYS[i % REACTION_KEYS.length], on: false }, "reactionMine");
      await paced();
    }

    // Dot voting: two rounds.
    for (let r = 0; r < SESSION.voteRounds; r++) {
      await host.act({ type: "voteStart", budget: SESSION.votesPerPersonPerRound }, "votingChanged");
      for (const [pi, p] of people.entries()) {
        for (let k = 0; k < SESSION.votesPerPersonPerRound; k++) await p.act({ type: "voteSet", noteId: note(pi * 7 + k), count: 1 }, "voteConfirmed");
        await refill(stub);
      }
      for (let i = 0; i < SESSION.voteChangesPerRound; i++) await nth(i).act({ type: "voteSet", noteId: note((i % 12) * 7), count: 0 }, "voteConfirmed");
      await host.act({ type: "voteStop" }, "votesRevealed");
      await host.act({ type: "voteClear" }, "votingChanged");
      await refill(stub);
    }

    // A silent round: 8 writers add 5 sealed notes each, then edit some, then the reveal.
    await host.act({ type: "silentStart" }, "silentChanged");
    const sealed: [Person, string][] = [];
    for (let i = 0; i < SESSION.sealedNotes; i++) {
      const p = nth(i % 8);
      const m = await p.act({ type: "noteAdd", clientRef: `q${i}`, x: 100 + i * 120, y: 3800, color: "orange", text: `Quiet idea ${i + 1}` }, "noteAdded", (m) => m.clientRef === `q${i}`);
      sealed.push([p, m.note.id]);
      await paced();
    }
    for (let i = 0; i < SESSION.sealedEdits; i++) {
      const [p, sid] = sealed[i] as [Person, string];
      await p.act({ type: "noteEdit", id: sid, text: `Quiet idea, reworded ${i}` }, "noteUpdated");
    }
    await host.act({ type: "silentReveal" }, "silentChanged");
    await refill(stub);

    // Chat, timer, lock, follow, Bring to me.
    for (let i = 0; i < SESSION.chat; i++) {
      await nth(i).act({ type: "say", text: `Comment ${i + 1}` }, "echo");
      await paced();
    }
    for (let i = 0; i < SESSION.timerStarts; i++) await host.act({ type: "timerStart", durationMs: 300_000 }, "timerChanged");
    for (let i = 0; i < SESSION.timerStops; i++) await host.act({ type: "timerStop" }, "timerChanged");
    await host.act({ type: "lockSet", locked: true }, "lockChanged");
    await host.act({ type: "lockSet", locked: false }, "lockChanged");
    await refill(stub);
    const hostId = (await runInDurableObject(stub, (_r: unknown, state: DurableObjectState) => {
      for (const ws of state.getWebSockets()) {
        const att = ws.deserializeAttachment() as { participant?: { id: string; host: boolean } | null } | null;
        if (att?.participant?.host) return att.participant.id;
      }
      return "";
    })) as string;
    const beforeFollow = await rows();
    for (const p of people.slice(1)) p.fire({ type: "followStart", target: hostId });
    for (let i = 0; i < 50; i++) {
      host.fire({ type: "viewport", x: 1000 + i, y: 1000, zoom: 1 });
      if (i % VIEWPORT_LIMITS.burst === VIEWPORT_LIMITS.burst - 1) {
        await host.sync();
        await refill(stub);
      }
    }
    await refill(stub);
    for (const p of people.slice(1)) p.fire({ type: "followStop" });
    host.fire({ type: "bringToMe", x: 3000, y: 2000, zoom: 0.5 });
    for (const p of people) await p.sync();
    await refill(stub);
    const followRows = (await rows()) - beforeFollow;

    // Deletes (with their reactions, arrows and groups), then 24 reconnects.
    for (let i = 0; i < SESSION.deletes; i++) {
      await nth(i).act({ type: "noteDelete", id: notes[i] as string }, "noteDeleted");
      await paced();
    }
    for (let i = 0; i < SESSION.reconnects; i++) {
      const p = nth(i);
      p.client.close();
      await p.enter(p === host ? token : undefined);
      await refill(stub);
    }
    // Pull everything still queued, so every message has been handled.
    await host.act({ type: "say", text: "Thanks, all" }, "echo");

    const written = await rows();
    const readDuringSession = await reads();
    // What a wake costs: the room loads every table once.
    const wakeRead = await runInDurableObject(stub, (_r: unknown, state: DurableObjectState) => {
      const cursors: { rowsRead: number }[] = [];
      const sql = { exec: (...args: unknown[]) => { const c = (state.storage.sql.exec as (...a: unknown[]) => { rowsRead: number })(...args); cursors.push(c); return c; } } as unknown as SqlStorage;
      // A wake reads what the first join needs: the meta keys the room loads, then every table (caches fill lazily).
      const store = new NoteStore(sql, (fn) => state.storage.transactionSync(fn));
      for (const key of ["locked", "timer_started_at", "timer_duration_ms", "voting_state", "voting_budget", "voting_round", "silent_active", "silent_round"]) store.getMeta(key);
      store.all();
      store.allFrames();
      store.allShapes();
      store.reactionCounts();
      store.allConnectors();
      store.allGroups();
      store.voterIds();
      return cursors.reduce((n, c) => n + c.rowsRead, 0);
    });
    for (const p of people) p.client.close();

    const measuredMessages = [...sent.values()].reduce((a, b) => a + b, 0);
    const result = {
      protocol: PROTOCOL_VERSION,
      opens,
      measuredMessages,
      byType: Object.fromEntries([...sent].sort((a, b) => b[1] - a[1])),
      rowsWritten: written,
      rowsReadDuringSession: readDuringSession,
      rowsReadPerWake: wakeRead,
      liveSampleRows: liveRows,
      followSampleRows: followRows,
    };
    // Printed for docs/LIMITS.md (a test file, not worker/src: the no-console rule is for the Worker).
    console.log(`[budget] ${JSON.stringify(result)}`);
    expect(liveRows).toBe(0);
    expect(followRows).toBe(0);
    expect(opens).toBe(SESSION.people + SESSION.reconnects);
    // Tripwires for LIMITS.md: if a change makes this session much dearer, the figures there need redoing.
    expect(written).toBeLessThan(6000);
    expect(readDuringSession).toBeLessThan(50_000);
  });
});
