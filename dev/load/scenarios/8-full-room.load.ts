import {
  CONNECTOR_DEFAULTS,
  FRAME_DEFAULTS,
  MAX_CONNECTORS_PER_ROOM,
  MAX_FRAMES_PER_ROOM,
  MAX_GROUPS_PER_ROOM,
  MAX_NOTES_PER_ROOM,
  MAX_REACTIONS_PER_REACTOR,
  MAX_REACTIONS_PER_ROOM,
  MAX_SERVER_MESSAGE_BYTES,
  MAX_SHAPES_PER_ROOM,
  NOTE_DEFAULTS,
  REACTION_KEYS,
  shapeDefaults,
} from "@stickyard/shared";
import { expect, inject, it } from "vitest";
import { Meter, Page, Raw, clientKey, fakeRoom, sleep } from "../harness";
import { report } from "../room";

/*
 * Section 2: a room filled to every cap (200 notes, 50 shapes, 30 frames, 100 arrows, 30 groups,
 * 2,000 reactions), with the longest storable content (4-byte emoji, so the largest a real room
 * can hold: lone surrogates can't be stored). Reports the join time and the size of each join-step
 * message, and checks one more of anything is refused and nothing is truncated.
 */

const relay = inject("relayUrl");
const EMOJI = "📝";
const text = (n: number) => EMOJI.repeat(n);

async function joined(code: string, meter: Meter, name: string, key?: string): Promise<Raw> {
  const raw = new Raw(relay, code, meter);
  await raw.open();
  await raw.enter(name, key);
  return raw;
}

async function paced(raw: Raw, messages: unknown[], perSecond: number): Promise<void> {
  for (const m of messages) {
    raw.send(m);
    await sleep(1000 / perSecond);
  }
}

it("a room at every cap: join time, join-step sizes, refusals, nothing truncated", async () => {
  const { code } = fakeRoom();
  const meter = new Meter();
  const filler = await joined(code, meter, "Filler", clientKey());

  // 200 notes at their longest storable text, two to an itemsAdd (the 4 KiB message cap decides).
  const notes = Array.from({ length: MAX_NOTES_PER_ROOM }, (_, i) => ({ ref: `n${i}`, x: (i % 20) * 300, y: Math.floor(i / 20) * 380, ...NOTE_DEFAULTS, w: 480, h: 480, text: text(280), color: "purple" }));
  const noteMsgs = [];
  for (let i = 0; i < notes.length; i += 2) noteMsgs.push({ type: "itemsAdd", clientRef: `notes${i}`, notes: notes.slice(i, i + 2) });
  // 50 shapes (one a message at 500 emoji), 30 frames (60-emoji titles, several a message).
  const shapeMsgs = Array.from({ length: MAX_SHAPES_PER_ROOM }, (_, i) => ({ type: "itemsAdd", clientRef: `shape${i}`, shapes: [{ ref: `s${i}`, kind: "diamond", x: (i % 10) * 600, y: 3600, ...shapeDefaults("diamond"), w: 2400, h: 1600, text: text(500), textColor: "auto" }] }));
  const frames = Array.from({ length: MAX_FRAMES_PER_ROOM }, (_, i) => ({ ref: `f${i}`, x: (i % 6) * 1000, y: Math.floor(i / 6) * 800, w: 2400, h: 1600, title: text(60), color: "orange", ...FRAME_DEFAULTS }));
  const frameMsgs = [];
  for (let i = 0; i < frames.length; i += 6) frameMsgs.push({ type: "itemsAdd", clientRef: `frames${i}`, frames: frames.slice(i, i + 6) });
  const fillStart = Date.now();
  await paced(filler, [...noteMsgs, ...shapeMsgs, ...frameMsgs], 20);
  for (let i = 0; i < noteMsgs.length + shapeMsgs.length + frameMsgs.length; i++) await filler.next("itemsAdded", 30_000);
  const all = await joined(code, meter, "Reader");
  const snapshot = all.frames.filter((f) => f.dir === "in").map((f) => JSON.parse(f.raw) as { type: string; notes?: { id: string }[]; shapes?: { id: string }[] });
  const noteIds = snapshot.find((m) => m.type === "snapshot")?.notes?.map((n) => n.id) ?? [];
  const shapeIds = snapshot.find((m) => m.type === "shapesSnapshot")?.shapes?.map((n) => n.id) ?? [];
  all.close();

  // 100 arrows bound at both ends (the longest anchor), 30 groups holding every note and shape.
  const items = [...noteIds, ...shapeIds];
  const arrows = Array.from({ length: MAX_CONNECTORS_PER_ROOM }, (_, i) => ({
    type: "connectorAdd",
    clientRef: `a${i}`,
    start: { item: items[i % items.length], anchor: "bottom" },
    end: { item: items[(i + 7) % items.length], anchor: "bottom" },
    ...CONNECTOR_DEFAULTS,
    dash: "dotted",
    width: "medium",
    ink: "neutral",
  }));
  await paced(filler, arrows, 50);
  for (let i = 0; i < arrows.length; i++) await filler.next("connectorAdded", 30_000);
  // Every item in one of the 30 groups: 250 items is 10 groups of 9 and 20 of 8.
  const bounds = Array.from({ length: MAX_GROUPS_PER_ROOM + 1 }, (_, i) => Math.round((i * items.length) / MAX_GROUPS_PER_ROOM));
  const groups = Array.from({ length: MAX_GROUPS_PER_ROOM }, (_, i) => ({ type: "groupCreate", clientRef: `g${i}`, label: text(40), color: "orange", members: items.slice(bounds[i], bounds[i + 1]) }));
  await paced(filler, groups, 20);
  for (let i = 0; i < groups.length; i++) await filler.next("groupCreated", 30_000);

  // 2,000 reactions: 20 reactors at their cap of 100 each, in parallel (each socket's bucket: 4 a second, burst 12).
  filler.close();
  await sleep(500);
  const pairs = noteIds.flatMap((id) => REACTION_KEYS.map((key) => ({ id, key })));
  const reactors = await Promise.all(Array.from({ length: MAX_REACTIONS_PER_ROOM / MAX_REACTIONS_PER_REACTOR }, (_, r) => joined(code, meter, `Reactor ${r + 1}`)));
  const reactStart = Date.now();
  await Promise.all(
    reactors.map(async (raw, r) => {
      raw.send({ type: "claimVoter", key: clientKey() });
      await raw.next("voterGranted");
      const mine = Array.from({ length: MAX_REACTIONS_PER_REACTOR }, (_, k) => pairs[(r * 60 + k) % pairs.length]!);
      await paced(raw, mine.map((p) => ({ type: "reactionSet", noteId: p.id, key: p.key, on: true })), 3.8);
      for (let k = 0; k < mine.length; k++) await raw.next("reactionMine", 30_000);
    }),
  );
  const reactMs = Date.now() - reactStart;

  // One more of everything is refused (a 21st reactor first frees a socket: the room holds 20 people).
  const last = reactors.pop() as Raw;
  last.close();
  await sleep(300);
  const extra = await joined(code, meter, "One more", clientKey());
  extra.send({ type: "claimVoter", key: clientKey() });
  await extra.next("voterGranted");
  const tries = [
    { type: "noteAdd", clientRef: "x1", x: 10, y: 10, color: "yellow", text: "" },
    { type: "shapeAdd", clientRef: "x2", kind: "rect", x: 10, y: 10 },
    { type: "frameAdd", clientRef: "x3", x: 10, y: 10, color: "neutral", title: "" },
    { type: "connectorAdd", clientRef: "x4", start: { x: 10, y: 10 }, end: { x: 300, y: 300 }, ...CONNECTOR_DEFAULTS },
    { type: "groupCreate", clientRef: "x5", label: "", color: "neutral", members: [noteIds[0], noteIds[1]] },
    { type: "reactionSet", noteId: noteIds[199], key: "plus", on: true },
  ];
  for (const m of tries) {
    extra.send(m);
    await sleep(100);
  }
  await sleep(800);
  const refusals = extra.queue.filter((m) => m.type === "error").map((m) => (m.type === "error" ? m.code : ""));
  extra.close();
  for (const r of reactors) r.close();
  await sleep(800);

  // Joins on the full room: five raw joins (time and bytes of each join-step message) and a web page.
  const joins: Awaited<ReturnType<Raw["enter"]>>[] = [];
  const first = () => joins[0]!;
  for (let i = 0; i < 5; i++) {
    const raw = new Raw(relay, code, meter);
    await raw.open();
    joins.push(await raw.enter(`Joiner ${i}`));
    raw.close();
    await sleep(200);
  }
  const page = new Page({ relay, code, name: "Web joiner", meter });
  const pageStart = Date.now();
  await page.join();
  const pageSyncedMs = Date.now() - pageStart;
  const pageRows = () => [...page.view.reactionCounts.values()].reduce((n, keys) => n + [...keys.values()].reduce((a, c) => a + c, 0), 0);
  await page.until((v) => v.board.groups.length === groups.length && v.board.connectors.length === MAX_CONNECTORS_PER_ROOM && pageRows() === MAX_REACTIONS_PER_ROOM, 20_000, "everything shown");
  const pageJoinMs = Date.now() - pageStart;
  const b = page.view.board;
  const reactionRows = pageRows();
  const rawReactionRows = first().board.reactions.reduce((n, [, keys]) => n + keys.reduce((a, [, c]) => a + c, 0), 0);
  page.close();

  const names = ["joined", "snapshot", "framesSnapshot", "shapesSnapshot", "reactionsSnapshot", "connectorsSnapshot", "groupsSnapshot"];
  const sizes = Object.fromEntries(first().bytes.slice(1).map((n, i) => [names[i] ?? `extra${i}`, n]));
  report("8. full room", {
    filled: { notes: first().board.notes.length, shapes: first().board.shapes.length, frames: first().board.frames.length, arrows: first().board.connectors.length, groups: first().board.groups.length, reactionRows: rawReactionRows },
    fillMs: Date.now() - fillStart,
    reactionsFillMs: reactMs,
    joinStepBytes: sizes,
    joinStepTotalBytes: first().bytes.reduce((a, n) => a + n, 0),
    largestMessageVsCap: `${Math.max(...first().bytes)} of ${MAX_SERVER_MESSAGE_BYTES}`,
    rawJoinMs: joins.map((j) => j.ms),
    webPageSyncedMs: pageSyncedMs,
    webPageEverythingShownMs: pageJoinMs,
    webPageShows: { notes: b.notes.length, shapes: b.shapes.length, frames: b.frames.length, arrows: b.connectors.length, groups: b.groups.length, reactionRows },
    oneMoreRefused: refusals,
  });
  expect(first().board.notes.length).toBe(MAX_NOTES_PER_ROOM);
  expect(first().board.shapes.length).toBe(MAX_SHAPES_PER_ROOM);
  expect(first().board.frames.length).toBe(MAX_FRAMES_PER_ROOM);
  expect(first().board.connectors.length).toBe(MAX_CONNECTORS_PER_ROOM);
  expect(first().board.groups.length).toBe(groups.length);
  expect(rawReactionRows).toBe(MAX_REACTIONS_PER_ROOM);
  expect(reactionRows).toBe(MAX_REACTIONS_PER_ROOM);
  expect(first().board.notes.every((n) => n.text === text(280))).toBe(true);
  expect(Math.max(...first().bytes)).toBeLessThan(MAX_SERVER_MESSAGE_BYTES);
  expect([b.notes.length, b.shapes.length, b.frames.length, b.connectors.length, b.groups.length]).toEqual([200, 50, 30, 100, groups.length]);
  expect(new Set(refusals)).toEqual(new Set(["notes_full", "shapes_full", "frames_full", "connectors_full", "groups_full", "reactions_full"]));
});
