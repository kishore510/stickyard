import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GROUP_PACE, GroupPacer, membersOf, type GroupMessage } from "../src/groups/pace";

/*
 * Groups part 2: group messages are paced on the page so the relay's GROUP_LIMITS (two per-socket
 * token buckets: messages and member ids) never refuse them. Explicit time budgets on a fake clock.
 */

/** The relay's GROUP_LIMITS, read from the Worker's source (the page can't import it). */
function relayLimits() {
  const source = readFileSync(new URL("../../worker/src/limits.ts", import.meta.url), "utf8");
  const block = /GROUP_LIMITS = \{([^}]*)\}/.exec(source)?.[1] ?? "";
  const n = (k: string) => Number(new RegExp(`${k}:\\s*([\\d.]+)`).exec(block)?.[1]);
  return { refillPerSecond: n("refillPerSecond"), burst: n("burst"), membersPerSecond: n("membersPerSecond"), membersBurst: n("membersBurst") };
}

function clock() {
  let now = 0;
  let timers: { at: number; fn: () => void; id: number }[] = [];
  let next = 1;
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => {
      const id = next++;
      timers.push({ at: now + ms, fn, id });
      return id;
    },
    clearTimer: (id: unknown) => {
      timers = timers.filter((t) => t.id !== id);
    },
    advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const due = timers.filter((t) => t.at <= until).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers = timers.filter((t) => t !== due);
        now = due.at;
        due.fn();
      }
      now = until;
    },
  };
}

/** Replays sends through the relay's own two buckets: false if any message would be refused. */
function relayAccepts(sends: readonly { at: number; members: number }[], l: ReturnType<typeof relayLimits>): boolean {
  let tokens = l.burst;
  let members = l.membersBurst;
  let at = 0;
  for (const s of sends) {
    tokens = Math.min(l.burst, tokens + ((s.at - at) / 1000) * l.refillPerSecond);
    members = Math.min(l.membersBurst, members + ((s.at - at) / 1000) * l.membersPerSecond);
    at = s.at;
    if (tokens < 1 || members < s.members) return false;
    tokens -= 1;
    members -= s.members;
  }
  return true;
}

describe("GroupPacer", () => {
  it("stays inside the relay's GROUP_LIMITS (read from the Worker)", () => {
    const l = relayLimits();
    expect(GROUP_PACE.burst).toBeLessThan(l.burst);
    expect(GROUP_PACE.perSecond).toBeLessThan(l.refillPerSecond);
    expect(GROUP_PACE.membersBurst).toBeLessThan(l.membersBurst);
    expect(GROUP_PACE.membersPerSecond).toBeLessThan(l.membersPerSecond);
  });

  it("Clear board's 30 ungroups go at once; 100 creates of 10 members each are paced so the relay accepts every one", () => {
    const c = clock();
    const sends: { at: number; members: number }[] = [];
    const pacer = new GroupPacer({ ...c, send: (m) => sends.push({ at: c.now(), members: membersOf(m) }) });
    for (let i = 0; i < 30; i++) pacer.enqueue({ type: "groupDelete", id: `G${i}` } as GroupMessage);
    expect(sends).toHaveLength(30);
    const members = Array.from({ length: 10 }, (_, i) => `M${i}`);
    for (let i = 0; i < 100; i++) pacer.enqueue({ type: "groupCreate", clientRef: `r${i}`, label: "", color: "neutral", members });
    let done = false;
    pacer.whenSent(() => (done = true));
    c.advance(5 * 60_000);
    expect(sends).toHaveLength(130);
    expect(done).toBe(true);
    expect(relayAccepts(sends, relayLimits())).toBe(true);
  });

  it("a reset drops what's queued and fills both buckets", () => {
    const c = clock();
    const sends: GroupMessage[] = [];
    const pacer = new GroupPacer({ ...c, send: (m) => sends.push(m), pace: { burst: 1, perSecond: 1, membersBurst: 10, membersPerSecond: 1 } });
    pacer.enqueue({ type: "groupDelete", id: "a" });
    pacer.enqueue({ type: "groupDelete", id: "b" });
    expect(pacer.queued).toBe(1);
    pacer.reset();
    c.advance(5000);
    expect(sends.map((m) => (m as { id: string }).id)).toEqual(["a"]);
  });
});

describe("group tokens", () => {
  it("--sy-group-pad mirrors GROUP_PAD, and the outline inks are the shape borders (3:1 on the board in both themes, tested with shapes)", async () => {
    const { GROUP_PAD } = await import("../src/groups/geometry");
    const { groupInk } = await import("../src/groups/groupUi");
    const tokens = readFileSync(new URL("../src/styles/tokens.css", import.meta.url), "utf8");
    expect(Number(/--sy-group-pad:\s*(\d+)px/.exec(tokens)?.[1])).toBe(GROUP_PAD);
    expect(groupInk("pink")).toBe("var(--sy-shape-pink-stroke)");
    const css = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");
    const block = css.slice(css.indexOf(".sy-group-box {"), css.indexOf(".sy-group-selected {"));
    expect(block).toContain("border-color: var(--sy-group-ink)");
    expect(block).toContain("border-style: dashed");
  });
});
