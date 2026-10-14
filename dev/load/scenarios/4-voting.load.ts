import { afterAll, expect, inject, it } from "vitest";
import { Raw, clientKey, sleep } from "../harness";
import { closeAll, openRoom, report, type Room } from "../room";

/*
 * Scenario 4: a dot-voting round. Twelve pages vote at once; two raw tabs with one key try to
 * overspend the shared budget at the same moment; nobody hears anything about others' votes while
 * open; the totals at stop equal every page's own votes; clear empties it.
 */

const relay = inject("relayUrl");
let room: Room | null = null;
afterAll(() => room && closeAll(room));

it("start, concurrent votes within the budget, stop, totals, clear", async () => {
  room = await openRoom(relay, 12);
  const { host, pages } = room;
  for (let i = 0; i < 8; i++) host.session.addNote({ x: 300 + i * 200, y: 400, color: "yellow", text: `Option ${i + 1}` });
  await host.until((v) => v.board.notes.filter((n) => n.confirmed).length === 8, 10_000, "options");
  await Promise.all(pages.map((p) => p.until((v) => v.board.notes.length === 8)));
  const ids = host.view.board.notes.map((n) => n.note.id);

  const budget = 3;
  expect(host.session.startVote(budget)).toBe(true);
  await Promise.all(pages.map((p) => p.until((v) => v.voting.state === "open", 10_000, "open")));
  const openAt = Date.now();

  // Every page spends its whole budget at once, a dot each on three notes (page i starts at note i).
  const mine = new Map<string, number>();
  for (const [i, p] of pages.entries()) {
    for (let k = 0; k < budget; k++) {
      const id = ids[(i + k) % ids.length] as string;
      expect(p.session.voteSet(id, 1)).toBe(true);
      mine.set(id, (mine.get(id) ?? 0) + 1);
    }
  }
  // The page itself refuses a fourth dot up front.
  const pageRefusesOverBudget = !(pages[0]?.session.voteSet(ids[7] as string, 2) ?? true);

  // Two raw tabs with the same key spend the same budget at the same moment: the relay keeps it.
  const key = clientKey();
  const tabs = [new Raw(relay, room.code, room.meter), new Raw(relay, room.code, room.meter)];
  for (const [i, t] of tabs.entries()) {
    await t.open();
    await t.enter(`Tab ${i + 1}`, key);
    t.send({ type: "claimVoter", key });
    await t.next("voterGranted");
  }
  (tabs[0] as Raw).send({ type: "voteSet", noteId: ids[0], count: budget });
  (tabs[1] as Raw).send({ type: "voteSet", noteId: ids[1], count: budget });
  await sleep(800);
  const tabErrors = tabs.flatMap((t) => t.queue.filter((m) => m.type === "error").map((m) => (m.type === "error" ? m.code : "")));
  const tabConfirmed = tabs.flatMap((t) => t.queue.filter((m) => m.type === "voteConfirmed"));
  const tabSpent = new Map<string, number>();
  for (const m of tabConfirmed) if (m.type === "voteConfirmed") tabSpent.set(m.noteId, m.count);
  for (const [id, n] of tabSpent) mine.set(id, (mine.get(id) ?? 0) + n);
  // A raw over-budget vote is refused outright.
  (tabs[0] as Raw).send({ type: "voteSet", noteId: ids[2], count: budget + 1 });
  await sleep(500);
  const overBudget = (tabs[0] as Raw).queue.some((m) => m.type === "error" && m.code === "over_budget");

  await sleep(1000);
  // While open, nobody hears about anyone else's votes (no totals, no other voter's confirmations).
  const otherVoteNews = pages.flatMap((p) =>
    p.inbound(openAt).filter((m) => m.type === "votesRevealed" || (m.type === "voteConfirmed" && !p.view.myVotes.has(m.noteId))),
  ).length;

  expect(host.session.stopVote()).toBe(true);
  await Promise.all(pages.map((p) => p.until((v) => v.voting.state === "closed" && v.results !== null, 10_000, "closed")));
  const totals = new Map((host.view.results ?? []).map((r) => [r.noteId, r.count]));
  const sameResults = pages.every((p) => JSON.stringify(p.view.results) === JSON.stringify(host.view.results));
  const totalsMatch = [...mine].every(([id, n]) => totals.get(id) === n) && [...totals.values()].reduce((a, b) => a + b, 0) === [...mine.values()].reduce((a, b) => a + b, 0);

  // A late joiner sees the closed round's totals.
  const late = new Raw(relay, room.code, room.meter);
  await late.open();
  await late.enter("Late");
  const lateTotals = await late.next("votesRevealed");

  expect(host.session.clearVotes()).toBe(true);
  await Promise.all(pages.map((p) => p.until((v) => v.voting.state === "off" && v.results === null, 10_000, "cleared")));

  report("4. voting", {
    voters: pages.length + 1,
    budget,
    dotsPlaced: [...mine.values()].reduce((a, b) => a + b, 0),
    pageRefusesOverBudget,
    sameKeyTwoTabs: { errors: tabErrors, confirmedCounts: [...tabSpent.values()] },
    rawOverBudgetRefused: overBudget,
    otherVoteNewsWhileOpen: otherVoteNews,
    totalsMatchVotes: totalsMatch,
    everyPageSameResults: sameResults,
    lateJoinerTotals: lateTotals.totals.length,
  });
  for (const t of [...tabs, late]) t.close();
  expect(pageRefusesOverBudget).toBe(true);
  expect(tabErrors).toEqual(["over_budget"]);
  expect(overBudget).toBe(true);
  expect(otherVoteNews).toBe(0);
  expect(totalsMatch).toBe(true);
  expect(sameResults).toBe(true);
  expect(lateTotals.totals.length).toBe(totals.size);
});
