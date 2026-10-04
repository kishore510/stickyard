import { describe, expect, it } from "vitest";
import {
  HIDDEN_GRACE_MS,
  LIMIT_MAX_PROBES,
  LIMIT_RETRY_MS,
  PROBE_AFTER_FAILED_OPENS,
  RECONNECT_BASE_MS,
  RECONNECT_JITTER,
  RECONNECT_MAX_ATTEMPTS,
  RECONNECT_MAX_DELAY_MS,
  afterFailedTry,
  backoffBase,
  backoffDelay,
  mayTryWhileHidden,
  shouldProbe,
} from "../src/connection/reconnect";

/*
 * The reconnect schedule (pure): exponential backoff with jitter, a cap on the delay and on the
 * number of automatic tries, the health-probe rule and the hidden-tab rule.
 */

describe("backoff schedule", () => {
  it("doubles from about 1 s and is capped at 30 s", () => {
    expect(RECONNECT_BASE_MS).toBe(1000);
    expect(RECONNECT_MAX_DELAY_MS).toBe(30_000);
    expect([1, 2, 3, 4, 5, 6, 7, 8, 20].map(backoffBase)).toEqual([1000, 2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000, 30_000]);
  });

  it("with no jitter (random = 0.5) the delay is the base", () => {
    expect([1, 2, 3, 6].map((a) => backoffDelay(a, () => 0.5))).toEqual([1000, 2000, 4000, 30_000]);
  });

  it("jitter stays within ±20% and never passes the cap", () => {
    expect(RECONNECT_JITTER).toBe(0.2);
    for (const attempt of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const base = backoffBase(attempt);
      for (const r of [0, 0.001, 0.25, 0.5, 0.75, 0.999, 1]) {
        const d = backoffDelay(attempt, () => r);
        expect(d).toBeGreaterThanOrEqual(Math.floor(base * (1 - RECONNECT_JITTER)));
        expect(d).toBeLessThanOrEqual(Math.min(RECONNECT_MAX_DELAY_MS, Math.ceil(base * (1 + RECONNECT_JITTER))));
        expect(Number.isInteger(d)).toBe(true);
      }
    }
    expect(backoffDelay(1, () => 0)).toBe(800);
    expect(backoffDelay(1, () => 1)).toBe(1200);
  });

  it("is never a tight loop: every delay is at least 800 ms, even with a broken random", () => {
    for (const r of [Number.NaN, -5, 7]) expect(backoffDelay(1, () => r)).toBeGreaterThanOrEqual(800);
    expect(backoffDelay(0, () => 0.5)).toBe(1000);
  });

  it("the whole automatic sequence takes about two minutes", () => {
    const total = Array.from({ length: RECONNECT_MAX_ATTEMPTS }, (_, i) => backoffBase(i + 1)).reduce((a, b) => a + b, 0);
    expect(total).toBe(121_000);
  });
});

describe("attempt cap", () => {
  it(`retries until ${RECONNECT_MAX_ATTEMPTS} tries have failed, then gives up`, () => {
    expect(RECONNECT_MAX_ATTEMPTS).toBe(8);
    for (let a = 1; a < RECONNECT_MAX_ATTEMPTS; a++) expect(afterFailedTry(a)).toBe("retry");
    expect(afterFailedTry(RECONNECT_MAX_ATTEMPTS)).toBe("give-up");
    expect(afterFailedTry(RECONNECT_MAX_ATTEMPTS + 3)).toBe("give-up");
    expect(afterFailedTry(2, 2)).toBe("give-up");
  });
});

describe("health probe rule", () => {
  it(`probes the relay after ${PROBE_AFTER_FAILED_OPENS} sockets in a row failed to open`, () => {
    expect(PROBE_AFTER_FAILED_OPENS).toBe(3);
    expect([0, 1, 2, 3, 4].map(shouldProbe)).toEqual([false, false, false, true, true]);
  });

  it("slows right down while the relay looks down: one probe a minute, for at most an hour", () => {
    expect(LIMIT_RETRY_MS).toBe(60_000);
    expect(LIMIT_MAX_PROBES * LIMIT_RETRY_MS).toBe(60 * 60_000);
  });
});

describe("hidden tabs", () => {
  it("tries while visible, and for a short while after the tab is hidden, then waits for it to be visible", () => {
    expect(HIDDEN_GRACE_MS).toBe(60_000);
    expect(mayTryWhileHidden(null, 1_000_000)).toBe(true);
    expect(mayTryWhileHidden(1_000_000, 1_000_000 + HIDDEN_GRACE_MS)).toBe(true);
    expect(mayTryWhileHidden(1_000_000, 1_000_000 + HIDDEN_GRACE_MS + 1)).toBe(false);
  });
});
