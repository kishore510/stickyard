import { NOTE_COLORS, REACTION_KEYS, SHAPE_KINDS, FRAME_COLORS } from "@stickyard/shared";
import { afterAll, expect, inject, it } from "vitest";
import { Page, rng, sleep } from "../harness";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { OUT, closeAll, convergence, errorCodes, openRoom, report, type Room } from "../room";

/*
 * Scenario 1: a burst of edits from 12 pages at once (notes, frames, shapes, arrows, groups,
 * reactions, z-order), through the web's own RoomSession. After the room goes quiet, every page's
 * board must be identical to the relay's snapshot for a fresh join.
 */

const relay = inject("relayUrl");
const SEED = Number(process.env.LOAD_SEED ?? 20261014);
const ACTIONS = Number(process.env.LOAD_ACTIONS ?? 40);
let room: Room | null = null;
afterAll(() => room && closeAll(room));

const pick = <T>(r: () => number, list: readonly T[]): T | undefined => list[Math.floor(r() * list.length)];
const confirmedNotes = (p: Page) => p.view.board.notes.filter((e) => e.confirmed !== null).map((e) => e.note.id);
const confirmedShapes = (p: Page) => p.view.board.shapes.filter((e) => e.confirmed !== null).map((e) => e.shape.id);
const confirmedFrames = (p: Page) => p.view.board.frames.filter((e) => e.confirmed !== null).map((e) => e.frame.id);
const confirmedArrows = (p: Page) => p.view.board.connectors.filter((e) => e.confirmed !== null).map((e) => e.connector.id);
const confirmedGroups = (p: Page) => p.view.board.groups.filter((e) => e.confirmed !== null).map((e) => e.group.id);

/** One random gesture, as a person would make it (drags and resizes send live updates, then a final one). */
async function gesture(p: Page, r: () => number, n: number): Promise<string> {
  const s = p.session;
  const x = 200 + Math.floor(r() * 3000);
  const y = 200 + Math.floor(r() * 2000);
  const note = pick(r, confirmedNotes(p));
  const shape = pick(r, confirmedShapes(p));
  const frame = pick(r, confirmedFrames(p));
  const roll = r();
  const live = async (steps: number, each: (i: number) => void) => {
    for (let i = 0; i < steps; i++) {
      each(i);
      await sleep(30 + Math.floor(r() * 30));
    }
  };
  if (roll < 0.14 || !note) {
    s.addNote({ x, y, color: pick(r, NOTE_COLORS) ?? "yellow", text: `Idea ${p.name} ${n}` });
    return "addNote";
  }
  if (roll < 0.22) {
    s.editNote(note, `Edited by ${p.name} (${n})`);
    return "editNote";
  }
  if (roll < 0.27) {
    s.styleNote(note, { color: pick(r, NOTE_COLORS) ?? "pink", bold: r() < 0.5 });
    return "styleNote";
  }
  if (roll < 0.37) {
    if (!s.startDrag(note)) return "skip";
    await live(6, (i) => s.moveNote(note, x + i * 10, y + i * 5, false));
    s.moveNote(note, x + 60, y + 30, true);
    return "moveNote";
  }
  if (roll < 0.42) {
    if (!s.startResize(note)) return "skip";
    await live(4, (i) => s.resizeNote(note, { x, y, w: 160 + i * 20, h: 160 + i * 10 }, false));
    s.resizeNote(note, { x, y, w: 240, h: 200 }, true);
    return "resizeNote";
  }
  if (roll < 0.47) {
    s.deleteNote(note);
    return "deleteNote";
  }
  if (roll < 0.5) {
    const ids = [...new Set([note, ...[pick(r, confirmedNotes(p)), pick(r, confirmedNotes(p))].filter((i): i is string => !!i)])];
    if (!s.startGroupDrag(ids)) return "skip";
    const at = ids.map((id, i) => ({ id, x: x + i * 180, y }));
    await live(4, (k) => s.moveGroup(at.map((a) => ({ ...a, x: a.x + k * 8 })), false));
    s.moveGroup(at, true);
    return "groupDrag";
  }
  if (roll < 0.54) {
    s.orderNotes([note, ...(shape ? [shape] : [])], r() < 0.5 ? "front" : "back");
    return "order";
  }
  if (roll < 0.6) {
    s.reactionSet(note, pick(r, REACTION_KEYS) ?? "heart", r() < 0.75);
    return "reaction";
  }
  if (roll < 0.64) {
    if (!frame || r() < 0.4) {
      s.addFrame({ x, y, color: pick(r, FRAME_COLORS) ?? "blue", title: `Frame ${n}` });
      return "addFrame";
    }
    if (r() < 0.3) {
      s.editFrame(frame, { title: `Theme ${p.name} ${n}` });
      return "editFrame";
    }
    if (r() < 0.15) {
      s.deleteFrame(frame);
      return "deleteFrame";
    }
    if (!s.startFrameDrag(frame, true)) return "skip";
    await live(5, (i) => s.moveFrame(frame, x + i * 12, y, false));
    s.moveFrame(frame, x + 70, y + 10, true);
    return "moveFrame";
  }
  if (roll < 0.72) {
    if (!shape || r() < 0.4) {
      s.addShape({ kind: pick(r, SHAPE_KINDS) ?? "rect", x, y });
      return "addShape";
    }
    const k = r();
    if (k < 0.3) {
      s.editShape(shape, { text: `Label ${n}` });
      return "editShape";
    }
    if (k < 0.45) {
      s.deleteShape(shape);
      return "deleteShape";
    }
    if (k < 0.7 && s.startShapeResize(shape)) {
      await live(3, (i) => s.resizeShape(shape, { x, y, w: 160 + i * 10, h: 100 }, false));
      s.resizeShape(shape, { x, y, w: 200, h: 120 }, true);
      return "resizeShape";
    }
    if (!s.startShapeDrag(shape)) return "skip";
    await live(4, (i) => s.moveShape(shape, x + i * 9, y, false));
    s.moveShape(shape, x + 40, y + 40, true);
    return "moveShape";
  }
  if (roll < 0.82) {
    const arrow = pick(r, confirmedArrows(p));
    const other = pick(r, confirmedNotes(p).filter((id) => id !== note));
    if (arrow && r() < 0.35) {
      if (r() < 0.4) {
        s.deleteConnectors([arrow]);
        return "deleteArrow";
      }
      s.updateConnector(arrow, { dash: r() < 0.5 ? "dashed" : "solid", end: { item: other ?? note, anchor: "auto" } });
      return "updateArrow";
    }
    const end = other ?? shape;
    if (!end) return "skip";
    s.addConnector({ start: { item: note, anchor: "auto" }, end: { item: end, anchor: "auto" } });
    return "addArrow";
  }
  if (roll < 0.92) {
    const group = pick(r, confirmedGroups(p));
    if (group && r() < 0.5) {
      const k = r();
      if (k < 0.3) s.updateGroup(group, { label: `Cluster ${n}` });
      else if (k < 0.6) s.addToGroup(group, [note]);
      else s.ungroup([group]);
      return k < 0.3 ? "updateGroup" : k < 0.6 ? "addToGroup" : "ungroup";
    }
    const members = [...new Set([note, pick(r, confirmedNotes(p)), shape].filter((i): i is string => !!i))];
    if (members.length < 2) return "skip";
    s.createGroup(members, { label: `Group ${n}` });
    return "createGroup";
  }
  s.addNote({ x, y, color: "green", text: "" });
  return "addNote";
}

it("12 pages bursting edits converge on the relay's snapshot", async () => {
  room = await openRoom(relay, 12);
  const r = rng(SEED);
  // Something to work on first: a few notes from each page.
  for (const [i, p] of room.pages.entries()) for (let k = 0; k < 3; k++) p.session.addNote({ x: 300 + i * 200, y: 300 + k * 200, color: "yellow", text: `Seed ${i}.${k}` });
  await sleep(1500);
  const counts: Record<string, number> = {};
  const started = Date.now();
  await Promise.all(
    room.pages.map(async (p, i) => {
      const mine = rng(SEED + i + 1);
      for (let n = 0; n < ACTIONS; n++) {
        const kind = await gesture(p, mine, n);
        counts[kind] = (counts[kind] ?? 0) + 1;
        await sleep(Math.floor(mine() * 150));
      }
    }),
  );
  void r;
  const burstMs = Date.now() - started;
  const { diffs, truth } = await convergence(relay, room);
  report("1. burst", {
    pages: room.pages.length,
    gestures: counts,
    burstMs,
    messagesIn: room.meter.inbound,
    messagesOut: room.meter.outbound,
    finalBoard: { notes: truth.notes.length, frames: truth.frames.length, shapes: truth.shapes.length, arrows: truth.connectors.length, groups: truth.groups.length, reactedNotes: truth.reactions.length },
    errorsToHonestPages: errorCodes(room.pages),
    differences: diffs.slice(0, 40),
    differenceCount: diffs.length,
  });
  if (diffs.length > 0) {
    // For each page that differs: every frame it sent or received about that item, in order.
    const lines: string[] = [];
    for (const d of diffs.filter((x) => x.includes("differs from confirmed") || x.includes("missing") || x.includes("only on"))) {
      const [name, rest] = d.split(": ");
      const id = /([A-Za-z0-9_-]{16})/.exec(rest ?? "")?.[1];
      const page = room.pages.find((p) => p.name === name);
      if (!id || !page) continue;
      lines.push(`=== ${d}`);
      for (const f of page.frames) if (f.raw.includes(id)) lines.push(`${f.at} ${f.dir} ${f.raw.slice(0, 400)}`);
    }
    writeFileSync(join(OUT, `burst-${SEED}.log`), lines.join("\n"));
    for (const p of room.pages) writeFileSync(join(OUT, `burst-${SEED}-${p.name.replace(" ", "")}.log`), p.frames.map((f) => `${f.at} ${f.dir} ${f.raw}`).join("\n"));
  }
  expect(diffs).toEqual([]);
  // Honest pages pace themselves inside every relay bucket.
  expect(errorCodes(room.pages).rate_limited ?? 0).toBe(0);
});
