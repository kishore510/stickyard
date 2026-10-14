import { MAX_FOLLOWERS } from "@stickyard/shared";
import { afterAll, expect, inject, it } from "vitest";
import { Page, parseServer, sleep } from "../harness";
import { closeAll, openRoom, report, type Room } from "../room";

/*
 * Scenario 3: Follow and Bring to me. Ten pages follow one leader (the cap), one more is refused,
 * the leader pans, then drops (its followers hear target_left), comes back, the host brings
 * everyone to its view, and the host leaves. Every frame is inspected: viewports reach only
 * followers, and counts are what the relay says.
 */

const relay = inject("relayUrl");
let room: Room | null = null;
afterAll(() => room && closeAll(room));

const inbound = (p: Page, since: number) => p.frames.filter((f) => f.dir === "in" && f.at >= since).map((f) => parseServer(f.raw));

it("follow, the follower cap, a leader dropping, Bring to me and the host leaving", async () => {
  room = await openRoom(relay, 12);
  const { host, pages } = room;
  const leader = pages[1] as Page;
  const followers = pages.slice(2, 12);
  const leaderId = leader.view.you?.id as string;

  // Ten follow the leader; the host (the 11th) is refused with followers_full.
  for (const f of followers) expect(f.session.startFollow(leaderId)).toBe(true);
  await sleep(800);
  const t0 = Date.now();
  host.session.startFollow(leaderId);
  await sleep(500);
  const hostRefused = inbound(host, t0).some((m) => m.type === "error" && m.code === "followers_full");
  const counts = inbound(leader, 0).filter((m) => m.type === "followersChanged").map((m) => (m.type === "followersChanged" ? m.count : -1));

  // The leader pans (as the canvas offers views): followers get viewportUpdate, nobody else does.
  const panStart = Date.now();
  for (let i = 0; i < 20; i++) {
    leader.session.shareViewport({ x: 1000 + i * 50, y: 800, zoom: 1 }, false);
    await sleep(50);
  }
  await sleep(600);
  const updates = (p: Page) => inbound(p, panStart).filter((m) => m.type === "viewportUpdate");
  const followerUpdates = followers.map((f) => updates(f).length);
  const lastSeen = followers.map((f) => {
    const last = updates(f).at(-1);
    return last?.type === "viewportUpdate" ? last.x : null;
  });
  const nonFollowerUpdates = [host, leader].map((p) => updates(p).length);
  const viewportsSent = leader.frames.filter((f) => f.dir === "out" && f.at >= panStart && f.raw.includes('"viewport"')).length;

  // The leader drops: every follower hears target_left; the leader rejoins with a new id.
  const dropAt = Date.now();
  leader.drop();
  await Promise.all(followers.map((f) => f.until(() => inbound(f, dropAt).some((m) => m.type === "followEnded" && m.reason === "target_left"), 10_000, "target_left")));
  await leader.until((v) => v.status === "joined" && v.you?.id !== leaderId, 20_000, "leader back");
  const leaderBackCount = inbound(leader, dropAt).filter((m) => m.type === "followersChanged").length;

  // Bring to me: everyone but the host gets one broughtToMe.
  const bringAt = Date.now();
  expect(host.session.bringToMe({ x: 3200, y: 2000, zoom: 0.5 })).toBe(true);
  await sleep(800);
  const brought = pages.map((p) => inbound(p, bringAt).filter((m) => m.type === "broughtToMe").length);

  // Half the room follows the host, then the host leaves: they hear target_left.
  const hostId = host.view.you?.id as string;
  const hostFollowers = followers.slice(0, 5);
  for (const f of hostFollowers) f.session.startFollow(hostId);
  await sleep(600);
  const leaveAt = Date.now();
  host.close();
  await sleep(1000);
  const ended = hostFollowers.map((f) => inbound(f, leaveAt).some((m) => m.type === "followEnded" && m.reason === "target_left"));
  const strayEnded = followers.slice(5).map((f) => inbound(f, leaveAt).some((m) => m.type === "followEnded"));

  report("3. follow", {
    followers: followers.length,
    hostRefusedWithFollowersFull: hostRefused,
    leaderCounts: counts,
    viewportsSentByLeader: viewportsSent,
    viewportUpdatesPerFollower: followerUpdates,
    lastViewSeenByFollowers: [...new Set(lastSeen)],
    viewportUpdatesToNonFollowers: nonFollowerUpdates,
    leaderFollowersAfterRejoin: leaderBackCount,
    broughtToMePerPage: brought,
    hostFollowersToldTargetLeft: ended,
    othersToldAnything: strayEnded,
  });
  expect(hostRefused).toBe(true);
  expect(Math.max(...counts)).toBe(MAX_FOLLOWERS);
  expect(viewportsSent).toBeLessThanOrEqual(Math.ceil((20 * 50) / 200) + 2);
  expect(followerUpdates.every((n) => n === viewportsSent)).toBe(true);
  expect(new Set(lastSeen).size).toBe(1);
  expect(nonFollowerUpdates).toEqual([0, 0]);
  expect(brought).toEqual([0, ...pages.slice(1).map(() => 1)]);
  expect(ended.every(Boolean)).toBe(true);
  expect(strayEnded.some(Boolean)).toBe(false);
});
