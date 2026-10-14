import { afterAll, expect, inject, it } from "vitest";
import { Meter, Page, Raw, clientKey, sleep } from "../harness";
import { closeAll, convergence, openRoom, report, type Room } from "../room";

/*
 * Scenario 2: a silent round. Several writers add sealed notes (one writer with a second tab), the
 * rest keep working, a guessing socket pokes at sealed ids, then the host reveals. Every frame each
 * recipient got is inspected: no sealed note's id or text may reach anyone but its writer's own
 * tabs, the counts must be honest, and after the reveal every page must match the relay.
 */

const relay = inject("relayUrl");
let room: Room | null = null;
const extra: Page[] = [];
afterAll(() => {
  if (room) closeAll(room);
  for (const p of extra) p.close();
});

const ID = /[A-Za-z0-9_-]{16}/g;

it("sealed notes reach only their writer's tabs, counts are honest, and the reveal converges", async () => {
  room = await openRoom(relay, 11);
  const { host, pages } = room;
  // A second tab of Person 2 (the same client key, so the same writer).
  const writerTwo = pages[1] as Page;
  const tab = new Page({ relay, code: room.code, name: "Person 2 (tab)", meter: room.meter, key: writerTwo.key });
  extra.push(tab);
  await tab.join();
  const everyone = [...pages, tab];

  // Visible notes before the round, to work on during it.
  for (let i = 0; i < 6; i++) host.session.addNote({ x: 200 + i * 200, y: 200, color: "blue", text: `Visible ${i}` });
  await host.until((v) => v.board.notes.filter((n) => n.confirmed).length === 6, 10_000, "visible notes");
  await Promise.all(everyone.map((p) => p.until((v) => v.board.notes.length >= 6)));

  expect(host.session.startSilent()).toBe(true);
  await Promise.all(everyone.map((p) => p.until((v) => v.silent.active, 10_000, "round started")));
  const roundStart = Date.now();

  // Writers: Persons 2 to 6 add 4 sealed notes each; Person 2's second tab adds 2 more as the same writer.
  const writers = pages.slice(1, 6);
  const marker = (p: Page, k: number) => `Sealed ${p.name} #${k}`;
  await Promise.all(
    writers.map(async (p) => {
      for (let k = 0; k < 4; k++) {
        p.session.addNote({ x: 400 + k * 180, y: 900, color: "pink", text: marker(p, k) });
        await sleep(40);
      }
    }),
  );
  for (let k = 4; k < 6; k++) tab.session.addNote({ x: 400 + k * 180, y: 900, color: "pink", text: marker(writerTwo, k) });
  const expected = writers.length * 4 + 2;
  await Promise.all(everyone.map((p) => p.until((v) => v.silent.count === expected, 15_000, `count ${expected}`)));

  // Writers edit, move and delete their own sealed notes; everyone else keeps working on visible notes.
  const sealedOf = (p: Page) => [...p.view.mySealed];
  for (const p of writers) {
    const [a, b] = sealedOf(p);
    if (a) p.session.editNote(a, `${marker(p, 0)} edited`);
    if (b && p.session.startDrag(b)) {
      p.session.moveNote(b, 900, 1200, false);
      await sleep(60);
      p.session.moveNote(b, 950, 1250, true);
    }
  }
  const visible = host.view.board.notes.filter((n) => !host.view.mySealed.has(n.note.id)).map((n) => n.note.id);
  for (const [i, p] of pages.slice(6).entries()) {
    const id = visible[i % visible.length] as string;
    p.session.editNote(id, `Visible edited by ${p.name}`);
    p.session.reactionSet(id, "heart", true);
  }
  const lastWriter = writers.at(-1) as Page;
  const deleted = sealedOf(lastWriter).at(-1) as string;
  lastWriter.session.deleteNote(deleted);
  await Promise.all(everyone.map((p) => p.until((v) => v.silent.count === expected - 1, 15_000, "count after delete")));

  // Every sealed note, its writer's key and text (from the writers' own boards).
  const sealed = new Map<string, { key: string; text: string }>();
  for (const p of [...writers, tab]) {
    for (const id of p.view.mySealed) {
      const text = p.view.board.notes.find((n) => n.note.id === id)?.note.text ?? "";
      sealed.set(id, { key: p.key, text });
    }
  }
  sealed.set(deleted, { key: lastWriter.key, text: marker(lastWriter, 3) });

  // A guessing socket with its own key pokes at every sealed id (as if one had leaked).
  const guess = new Raw(relay, room.code, room.meter);
  await guess.open();
  await guess.enter("Guesser", clientKey());
  guess.send({ type: "claimVoter", key: clientKey() });
  await guess.next("voterGranted");
  const someId = [...sealed.keys()][0] as string;
  const visibleId = visible[0] as string;
  for (const id of [...sealed.keys()].slice(0, 6)) {
    guess.send({ type: "noteEdit", id, text: "overwritten" });
    guess.send({ type: "noteMove", id, x: 10, y: 10, final: true });
    guess.send({ type: "noteDelete", id });
    guess.send({ type: "reactionSet", noteId: id, key: "plus", on: true });
    await sleep(300);
  }
  guess.send({ type: "connectorAdd", clientRef: "g1", start: { item: someId, anchor: "auto" }, end: { item: visibleId, anchor: "auto" }, route: "straight", dash: "solid", width: "medium", ink: "neutral", startHead: "none", endHead: "arrow" });
  guess.send({ type: "groupCreate", clientRef: "g2", label: "", color: "neutral", members: [someId, visibleId] });
  guess.send({ type: "notesOrder", ids: [someId], action: "front" });
  await sleep(1000);
  const guessReplies = guess.queue.filter((m) => m.type === "error").map((m) => (m.type === "error" ? m.code : ""));

  // Inspect every frame each recipient got during the round: no other writer's sealed id or text.
  const roundEnd = Date.now();
  const writerKeys = new Map(writers.map((p) => [p.name, p.key]));
  const leaks: string[] = [];
  const recipients: { name: string; key: string; frames: { at: number; raw: string; dir: string }[] }[] = [
    ...everyone.map((p) => ({ name: p.name, key: p.key, frames: p.frames })),
    { name: "Guesser", key: "guesser", frames: guess.frames },
  ];
  for (const r of recipients) {
    // An id a socket sent itself may be echoed back (an error names what it refused), exactly as for an unknown id.
    const sentByIt = new Set(r.frames.filter((f) => f.dir === "out").flatMap((f) => f.raw.match(ID) ?? []));
    for (const f of r.frames) {
      if (f.dir !== "in" || f.at < roundStart || f.at > roundEnd) continue;
      for (const id of f.raw.match(ID) ?? []) {
        const s = sealed.get(id);
        if (s && s.key !== r.key && !sentByIt.has(id)) leaks.push(`${r.name} got sealed id ${id}: ${f.raw.slice(0, 160)}`);
      }
      for (const m of f.raw.matchAll(/Sealed (Person \d+) #/g)) {
        if (writerKeys.get(m[1] ?? "") !== r.key) leaks.push(`${r.name} got sealed text of ${m[1]}`);
      }
    }
  }
  // The guesser changed nothing: every writer still has its sealed notes as it left them.
  const counts = everyone.map((p) => p.view.silent.count);
  const tabSees = [...tab.view.mySealed].sort().join() === [...writerTwo.view.mySealed].sort().join();

  // Reveal: every note to everyone, then every page matches the relay.
  expect(host.session.revealSilent()).toBe(true);
  await Promise.all(everyone.map((p) => p.until((v) => !v.silent.active, 15_000, "revealed")));
  const { diffs, truth } = await convergence(relay, room, everyone);
  const revealedTexts = truth.notes.filter((n) => n.text.startsWith("Sealed")).length;
  report("2. silent round", {
    pages: everyone.length,
    writers: writers.length + 1,
    sealedAdded: expected,
    sealedAfterDelete: expected - 1,
    countsSeenByEveryPage: [...new Set(counts)],
    secondTabSeesSameSealed: tabSees,
    framesInspected: recipients.reduce((n, r) => n + r.frames.filter((f) => f.dir === "in" && f.at >= roundStart && f.at <= roundEnd).length, 0),
    leaks: leaks.slice(0, 20),
    leakCount: leaks.length,
    guesserReplies: guessReplies,
    revealedSealedNotes: revealedTexts,
    differencesAfterReveal: diffs.slice(0, 20),
  });
  guess.close();
  expect(leaks).toEqual([]);
  expect(new Set(counts)).toEqual(new Set([expected - 1]));
  expect(tabSees).toBe(true);
  // Sealed notes look exactly like unknown ones to the guesser: unknown_note for the reaction, unknown_item for arrows and groups, silent_active refusals, nothing else.
  expect(guessReplies.every((c) => ["unknown_note", "unknown_item", "silent_active"].includes(c))).toBe(true);
  expect(revealedTexts).toBe(expected - 1);
  expect(diffs).toEqual([]);
});
