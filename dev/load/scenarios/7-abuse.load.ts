import { afterAll, expect, inject, it } from "vitest";
import { Raw, clientKey, sleep } from "../harness";
import { closeAll, convergence, errorCodes, openRoom, report, type Room } from "../room";

/*
 * Scenario 7: one misbehaving socket. It sends malformed and oversized frames, then floods every
 * rate bucket (messages, cursors, viewports, reactions, arrows, groups, batch entries). It must be
 * refused and closed, and the eleven honest pages must not slow down or see its flood.
 */

const relay = inject("relayUrl");
let room: Room | null = null;
afterAll(() => room && closeAll(room));

/** Round trips of a page's own adds (send to the relay's confirmation), in ms. */
async function roundTrips(room: Room, n: number): Promise<number[]> {
  const out: number[] = [];
  const page = room.pages[2]!;
  for (let i = 0; i < n; i++) {
    const start = Date.now();
    const local = page.session.addNote({ x: 3000 + (i % 10) * 170, y: 3000, color: "green", text: `Probe ${i}` });
    await page.until((v) => v.board.notes.some((e) => e.confirmed !== null && e.note.text === `Probe ${i}` && e.note.id !== local), 10_000, "probe confirmed");
    out.push(Date.now() - start);
    await sleep(100);
  }
  return out;
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;

it("a flooding, malformed socket is limited and closed without slowing the others", async () => {
  room = await openRoom(relay, 11);
  const quietRtt = await roundTrips(room, 10);

  const bad = new Raw(relay, room.code, room.meter);
  await bad.open();
  await bad.enter("Noisy", clientKey());
  bad.send({ type: "claimVoter", key: clientKey() });
  await bad.next("voterGranted");
  const noteId = room.host.view.board.notes[0]?.note.id ?? "AAAAAAAAAAAAAAAA";

  // Malformed first: each gets a reply, never a crash.
  const malformed: (string | object)[] = [
    "not json",
    "{",
    "null",
    "[]",
    '{"type":"noteAdd"}',
    '{"type":"nope"}',
    '{"__proto__":{"polluted":true},"type":"say","text":"hi"}',
    `${"[".repeat(1900)}${"]".repeat(1900)}`,
    JSON.stringify({ type: "say", text: "x".repeat(5000) }),
    { type: "noteAdd", clientRef: "r", x: -5, y: 1e12, color: "red", text: "" },
    { type: "join", name: "Again" },
    { type: "claimHost", token: "A".repeat(43) },
  ];
  const sentAt = Date.now();
  for (const m of malformed) {
    bad.send(m);
    await sleep(30);
  }
  await sleep(500);
  const malformedReplies = bad.frames.filter((f) => f.dir === "in" && f.at >= sentAt).map((f) => /"code":"(\w+)"/.exec(f.raw)?.[1] ?? /"type":"(\w+)"/.exec(f.raw)?.[1]);

  // Then a flood across every bucket, as fast as the socket takes it, while the honest pages work.
  const floodAt = Date.now();
  const floodRttPromise = roundTrips(room, 10);
  let sent = 0;
  const flood = (async () => {
    for (let i = 0; i < 4000 && bad.closed === null; i++) {
      const k = i % 8;
      const m =
        k === 0
          ? { type: "say", text: `spam ${i}` }
          : k === 1
            ? { type: "cursor", x: i % 6000, y: 10 }
            : k === 2
              ? { type: "viewport", x: 10, y: 10, zoom: 1 }
              : k === 3
                ? { type: "reactionSet", noteId, key: "heart", on: i % 2 === 0 }
                : k === 4
                  ? { type: "connectorAdd", clientRef: `c${i}`, start: { x: 10, y: 10 }, end: { x: 500, y: 500 }, route: "straight", dash: "solid", width: "thin", ink: "neutral", startHead: "none", endHead: "arrow" }
                  : k === 5
                    ? { type: "noteAdd", clientRef: `n${i}`, x: 100, y: 100, color: "yellow", text: "spam" }
                    : k === 6
                      ? { type: "noteBatch", ops: Array.from({ length: 50 }, () => ({ op: "move", id: noteId, x: 1, y: 1 })), final: false }
                      : "garbage";
      bad.send(m);
      sent++;
      if (i % 50 === 0) await sleep(1);
    }
  })();
  await flood;
  const closeWait = Date.now();
  while (bad.closed === null && Date.now() - closeWait < 15_000) await sleep(100);
  const closedAfterMs = Date.now() - floodAt;
  const floodRtt = await floodRttPromise;
  const afterRtt = await roundTrips(room, 10);

  // What reached the honest pages from the flood: spam echoes and the noisy socket's cursor.
  const noisyId = room.host.view.participants.find((p) => p.name === "Noisy")?.id;
  const reachedPages = room.pages.map((p) => p.inbound(floodAt).filter((m) => (m.type === "echo" && m.text.startsWith("spam")) || (m.type === "cursorMoved" && m.id === noisyId)).length);
  const noisyNotes = (await convergence(relay, room)).truth.notes.filter((n) => n.text === "spam").length;
  const { diffs } = await convergence(relay, room);
  const rateLimited = bad.frames.filter((f) => f.dir === "in" && f.at >= floodAt && f.raw.includes('"rate_limited"')).length;

  report("7. misbehaving socket", {
    malformedReplies,
    floodMessagesSent: sent,
    closedWithCode: bad.closed,
    closedAfterMs,
    rateLimitedReplies: rateLimited,
    spamThatReachedEachPage: reachedPages,
    spamNotesStored: noisyNotes,
    honestRoundTripMs: { quietMedian: median(quietRtt), duringFloodMedian: median(floodRtt), duringFloodMax: Math.max(...floodRtt), afterMedian: median(afterRtt) },
    honestPagesErrors: errorCodes(room.pages),
    differences: diffs.length,
  });
  expect(malformedReplies.length).toBeGreaterThanOrEqual(malformed.length);
  expect(bad.closed).toBe(1008);
  expect(errorCodes(room.pages)).toEqual({});
  expect(diffs).toEqual([]);
  // Honest pages are not starved: during the flood their adds still confirm well within a second.
  expect(Math.max(...floodRtt)).toBeLessThan(1000);
});
