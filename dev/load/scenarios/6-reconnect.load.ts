import { afterAll, expect, it } from "vitest";
import { RECONNECT_MAX_ATTEMPTS } from "../../../web/src/connection/reconnect";
import { Page, sleep } from "../harness";
import { startLocalRelay, type LocalRelay } from "../relay";
import { closeAll, convergence, openRoom, report, type Room } from "../room";

/*
 * Scenario 6: a reconnect storm. (a) Every page's socket drops at once with the relay still up;
 * (b) the relay itself goes away and comes back on the same storage (a deploy). Pages must come
 * back on the web's backoff (one try per page in (a); a handful in (b), never a loop), converge,
 * and every rejoin's snapshot must match the relay. This file runs its own local relay so it can
 * stop and restart it.
 */

let relay: LocalRelay | null = null;
let room: Room | null = null;
afterAll(async () => {
  if (room) closeAll(room);
  await relay?.dispose();
});

const gaps = (times: number[]) => times.slice(1).map((t, i) => t - (times[i] as number));

async function seed(r: Room): Promise<void> {
  for (const [i, p] of r.pages.entries()) {
    p.session.addNote({ x: 200 + i * 150, y: 300, color: "yellow", text: `Before the storm ${i}` });
    p.session.addShape({ kind: "oval", x: 200 + i * 150, y: 700 });
  }
  await Promise.all(r.pages.map((p) => p.until((v) => v.board.notes.filter((n) => n.confirmed).length === 12 && v.board.shapes.filter((s) => s.confirmed).length === 12, 15_000, "seeded")));
}

it("all pages drop at once, then the relay restarts: backoff, convergence, consistent snapshots", async () => {
  relay = await startLocalRelay(Number(process.env.LOAD_STORM_PORT ?? 8798));
  const url = relay.url.href;
  room = await openRoom(url, 12);
  await seed(room);
  const pages = room.pages;

  // (a) Every socket drops at once; the relay stays up.
  const opensBefore = pages.map((p) => p.opens.length);
  const dropAt = Date.now();
  for (const p of pages) p.drop();
  await Promise.all(pages.map((p) => p.until((v) => v.status !== "joined", 5000, "dropped")));
  await Promise.all(pages.map((p) => p.until((v) => v.status === "joined" && v.synced, 30_000, "rejoined")));
  const rejoinMs = Date.now() - dropAt;
  await sleep(1500);
  const triesA = pages.map((p, i) => p.opens.length - (opensBefore[i] as number));
  const a = await convergence(url, room);

  // Some work after the storm, so the rejoined pages are live.
  for (const [i, p] of pages.entries()) p.session.addNote({ x: 200 + i * 150, y: 1100, color: "green", text: `After the storm ${i}` });
  const a2 = await convergence(url, room);

  // (b) A deploy: the relay goes away for a while and comes back on the same storage.
  const before = pages.map((p) => p.opens.length);
  const healthBefore = room.meter.health;
  const downAt = Date.now();
  await relay.stop();
  await Promise.all(pages.map((p) => p.until((v) => v.status !== "joined", 10_000, "noticed the deploy")));
  await sleep(Number(process.env.LOAD_DOWN_MS ?? 8000));
  await relay.restart();
  const upAt = Date.now();
  await Promise.all(pages.map((p) => p.until((v) => v.status === "joined" && v.synced, 90_000, "back after the deploy")));
  const backMs = Date.now() - upAt;
  await sleep(1500);
  const tries = pages.map((p, i) => p.opens.slice(before[i]));
  const triesWhileDown = tries.map((t) => t.filter((at) => at < upAt).length);
  const minGap = Math.min(...tries.flatMap((t) => gaps(t)));
  const b = await convergence(url, room);
  const phases = pages.map((p) => p.view.reconnect?.phase ?? "joined");

  report("6. reconnect storm", {
    pages: pages.length,
    a_dropAllAtOnce: { triesPerPage: [...new Set(triesA)], allBackMs: rejoinMs, differences: a.diffs.length, differencesAfterNewWork: a2.diffs.length },
    b_deploy: {
      relayDownMs: upAt - downAt,
      triesPerPageWhileDown: triesWhileDown,
      triesPerPageInAll: tries.map((t) => t.length),
      shortestGapBetweenTriesMs: minGap,
      healthProbes: room.meter.health - healthBefore,
      allBackAfterRelayUpMs: backMs,
      differences: b.diffs.slice(0, 10),
      finalPhases: [...new Set(phases)],
    },
    boardAfter: { notes: b.truth.notes.length, shapes: b.truth.shapes.length },
  });
  expect(triesA.every((n) => n === 1)).toBe(true);
  expect(a.diffs).toEqual([]);
  expect(a2.diffs).toEqual([]);
  expect(Math.max(...triesWhileDown)).toBeLessThanOrEqual(RECONNECT_MAX_ATTEMPTS);
  // Backoff: never two tries from one page within half a second (the first retry waits about 1 s, ±20%).
  expect(minGap).toBeGreaterThanOrEqual(500);
  expect(b.diffs).toEqual([]);
  expect(b.truth.notes.length).toBe(24);
});

void Page;
