import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Meter, Page, Raw, diffBoards, fakeRoom, pageBoard, settle, type CanonBoard } from "./harness";

/* A room of simulated pages for one scenario, and the report every scenario writes into. */

export const OUT = join(import.meta.dirname, "out");

/** Appends one section's numbers to out/report.jsonl (gitignored) and prints them. */
export function report(section: string, data: Record<string, unknown>): void {
  mkdirSync(OUT, { recursive: true });
  appendFileSync(join(OUT, "report.jsonl"), `${JSON.stringify({ section, at: new Date().toISOString(), ...data })}\n`);
  process.stdout.write(`\n[load] ${section}: ${JSON.stringify(data, null, 1)}\n`);
}

export interface Room {
  code: string;
  id: string;
  hostToken: string;
  meter: Meter;
  pages: Page[];
  host: Page;
}

/** `n` pages in a fresh room, the first one the host (it holds the host token), all joined. */
export async function openRoom(relay: string, n: number, names = (i: number) => `Person ${i + 1}`): Promise<Room> {
  const { code, id, hostToken } = fakeRoom();
  const meter = new Meter();
  const pages = Array.from({ length: n }, (_, i) => new Page({ relay, code, name: names(i), meter, ...(i === 0 ? { hostToken } : {}) }));
  await Promise.all(pages.map((p) => p.join()));
  const host = pages[0] as Page;
  await host.until((v) => v.isHost, 10_000, "host granted");
  await Promise.all(pages.map((p) => p.until((v) => v.isVoter, 10_000, "voter granted")));
  return { code, id, hostToken, meter, pages, host };
}

/** The relay's board as a fresh raw joiner gets it, with the join's size and time. */
export async function relayBoard(relay: string, room: Room): Promise<{ board: CanonBoard; bytes: number[]; ms: number }> {
  const raw = new Raw(relay, room.code, new Meter());
  await raw.open();
  const out = await raw.enter("Checker");
  raw.close();
  return out;
}

/**
 * After the room goes quiet: every page's board (what the web shows) must equal the relay's
 * snapshot for a fresh join, with nothing left pending. Returns every difference found.
 */
export async function convergence(relay: string, room: Room, pages: readonly Page[] = room.pages): Promise<{ diffs: string[]; truth: CanonBoard }> {
  await settle(pages);
  const { board: truth } = await relayBoard(relay, room);
  const diffs: string[] = [];
  for (const page of pages) {
    const { board, pending } = pageBoard(page.view);
    diffs.push(...pending.map((p) => `${page.name}: ${p}`), ...diffBoards(board, truth, page.name));
  }
  return { diffs, truth };
}

export function closeAll(room: Room): void {
  for (const p of room.pages) p.close();
}

/** Error codes each page received, counted. */
export function errorCodes(pages: readonly Page[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of pages) {
    for (const m of p.inbound()) if (m.type === "error") out[m.code] = (out[m.code] ?? 0) + 1;
  }
  return out;
}
