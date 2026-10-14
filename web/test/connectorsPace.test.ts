import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CONNECTOR_PACE, ConnectorPacer } from "../src/connectors/pace";

/*
 * Arrows part 2: connector messages are paced on the page so the relay's CONNECTOR_LIMITS (a
 * per-socket token bucket) never refuses them. Explicit time budgets on a fake clock, so the
 * result doesn't depend on how fast the runner is.
 */

/** The relay's CONNECTOR_LIMITS, read from the Worker's source (the page can't import it). */
function relayLimits(): { refillPerSecond: number; burst: number } {
  const source = readFileSync(new URL("../../worker/src/limits.ts", import.meta.url), "utf8");
  const block = /CONNECTOR_LIMITS = \{([^}]*)\}/.exec(source)?.[1] ?? "";
  return { refillPerSecond: Number(/refillPerSecond:\s*([\d.]+)/.exec(block)?.[1]), burst: Number(/burst:\s*(\d+)/.exec(block)?.[1]) };
}

/** A fake clock with timers, advanced by hand. */
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

/** Replays send times through the relay's own bucket: false if any message would be refused. */
function relayAccepts(times: readonly number[], { refillPerSecond, burst }: { refillPerSecond: number; burst: number }): boolean {
  let tokens = burst;
  let at = 0;
  for (const t of times) {
    tokens = Math.min(burst, tokens + ((t - at) / 1000) * refillPerSecond);
    at = t;
    if (tokens < 1) return false;
    tokens -= 1;
  }
  return true;
}

describe("ConnectorPacer", () => {
  it("stays inside the relay's CONNECTOR_LIMITS, with room to spare", () => {
    const relay = relayLimits();
    expect(relay).toEqual({ refillPerSecond: 4, burst: 100 });
    expect(CONNECTOR_PACE.burst).toBeLessThanOrEqual(relay.burst);
    expect(CONNECTOR_PACE.perSecond).toBeLessThan(relay.refillPerSecond);
  });

  it("a burst goes at once up to the budget; the rest follow at the sustained rate", () => {
    const c = clock();
    const times: number[] = [];
    const pacer = new ConnectorPacer({ now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer, send: () => times.push(c.now()) });
    for (let i = 0; i < 160; i++) pacer.enqueue({ type: "connectorDelete", id: `conn${String(i).padStart(12, "0")}` });
    expect(times).toHaveLength(CONNECTOR_PACE.burst);
    expect(pacer.queued).toBe(160 - CONNECTOR_PACE.burst);
    // Ten seconds later: the burst plus at most 3.5 a second.
    c.advance(10_000);
    expect(times.length).toBeLessThanOrEqual(CONNECTOR_PACE.burst + Math.floor(10 * CONNECTOR_PACE.perSecond));
    expect(times.length).toBeGreaterThanOrEqual(CONNECTOR_PACE.burst + Math.floor(10 * CONNECTOR_PACE.perSecond) - 1);
    c.advance(60_000);
    expect(times).toHaveLength(160);
    expect(relayAccepts(times, relayLimits())).toBe(true);
  });

  it("messages arriving late at the relay together still fit (sustained rate below the relay's)", () => {
    const c = clock();
    const times: number[] = [];
    const pacer = new ConnectorPacer({ now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer, send: () => times.push(c.now()) });
    for (let i = 0; i < 300; i++) pacer.enqueue({ type: "connectorDelete", id: `conn${String(i).padStart(12, "0")}` });
    c.advance(120_000);
    // Every gap squeezed by up to 200 ms of network jitter.
    const bunched = times.map((t, i) => Math.max(0, t - (i % 2 === 0 ? 200 : 0))).sort((a, b) => a - b);
    expect(relayAccepts(bunched, relayLimits())).toBe(true);
  });

  it("whenSent runs once the queue is empty (now if it is); reset drops what's queued", () => {
    const c = clock();
    const sent: unknown[] = [];
    const pacer = new ConnectorPacer({ now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer, send: (m) => sent.push(m), burst: 2, perSecond: 1 });
    let ran = 0;
    pacer.whenSent(() => ran++);
    expect(ran).toBe(1);
    for (let i = 0; i < 4; i++) pacer.enqueue({ type: "connectorDelete", id: `conn${String(i).padStart(12, "0")}` });
    pacer.whenSent(() => ran++);
    expect(ran).toBe(1);
    c.advance(2000);
    expect(sent).toHaveLength(4);
    expect(ran).toBe(2);
    for (let i = 0; i < 3; i++) pacer.enqueue({ type: "connectorDelete", id: `conn${String(i).padStart(12, "0")}` });
    pacer.reset();
    c.advance(10_000);
    expect(pacer.queued).toBe(0);
    // A reset bucket is full again (a new socket's bucket is full on the relay too).
    expect(sent).toHaveLength(4);
  });
});
