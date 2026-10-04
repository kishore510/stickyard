import { describe, expect, it } from "vitest";
import { TIMER_MAX_MS, TIMER_MIN_MS } from "@stickyard/shared";
import {
  FINAL_MS,
  FINISHED_HIDE_MS,
  TIMER_PRESETS_MIN,
  TIMER_TEXT,
  chipVisible,
  durationLabel,
  formatRemaining,
  parseMinutes,
  remaining,
  stopNeedsConfirm,
  timerAnnouncement,
  timerPhase,
} from "../src/timer/timer";

/* The room timer (facilitation UI, web only): pure rules, tested. */

const T = { startedAt: 1_000_000, durationMs: 300_000 };

describe("remaining", () => {
  it("counts down from the relay's start by the relay's clock (this clock + offset)", () => {
    expect(remaining(T, 1_000_000, 0)).toBe(300_000);
    expect(remaining(T, 1_060_000, 0)).toBe(240_000);
    // This device is 5 s behind the relay: 5 s more have passed than its own clock says.
    expect(remaining(T, 1_000_000, 5_000)).toBe(295_000);
    // 3 s ahead.
    expect(remaining(T, 1_000_000, -3_000)).toBe(300_000);
  });

  it("is never negative, and 0 exactly at the end", () => {
    expect(remaining(T, 1_300_000, 0)).toBe(0);
    expect(remaining(T, 9_999_999, 0)).toBe(0);
  });

  it("is worked out from timestamps, so a long gap (a throttled tab) lands on the right value", () => {
    const after = (ms: number) => remaining(T, 1_000_000 + ms, 0);
    expect(after(123_456)).toBe(300_000 - 123_456);
    // Not drifting: the same moment gives the same answer however it was reached.
    expect(after(200_000)).toBe(after(100_000) - 100_000);
  });

  it("handles the longest timer", () => {
    expect(remaining({ startedAt: 0, durationMs: TIMER_MAX_MS }, 1, 0)).toBe(TIMER_MAX_MS - 1);
  });
});

describe("formatRemaining", () => {
  it("is mm:ss, rounding up to whole seconds (so it reads 00:00 only at the end)", () => {
    expect(formatRemaining(300_000)).toBe("05:00");
    expect(formatRemaining(299_001)).toBe("05:00");
    expect(formatRemaining(299_000)).toBe("04:59");
    expect(formatRemaining(61_000)).toBe("01:01");
    expect(formatRemaining(1)).toBe("00:01");
    expect(formatRemaining(0)).toBe("00:00");
    expect(formatRemaining(-5)).toBe("00:00");
  });

  it("is h:mm:ss from an hour", () => {
    expect(formatRemaining(3_600_000)).toBe("1:00:00");
    expect(formatRemaining(3_599_000)).toBe("59:59");
    expect(formatRemaining(TIMER_MAX_MS)).toBe("3:00:00");
    expect(formatRemaining(3_725_000)).toBe("1:02:05");
  });
});

describe("timerPhase", () => {
  it("running, then the final minute, then finished", () => {
    expect(timerPhase(FINAL_MS + 1)).toBe("running");
    expect(timerPhase(FINAL_MS)).toBe("final");
    expect(timerPhase(1)).toBe("final");
    expect(timerPhase(0)).toBe("finished");
    expect(FINAL_MS).toBe(60_000);
  });
});

describe("chipVisible", () => {
  it("shows while running and for 10 minutes after it finished, then hides here", () => {
    const end = T.startedAt + T.durationMs;
    expect(chipVisible(T, end - 1, 0)).toBe(true);
    expect(chipVisible(T, end + FINISHED_HIDE_MS - 1, 0)).toBe(true);
    expect(chipVisible(T, end + FINISHED_HIDE_MS, 0)).toBe(false);
    expect(chipVisible(null, end, 0)).toBe(false);
    expect(FINISHED_HIDE_MS).toBe(10 * 60_000);
  });
});

describe("timerAnnouncement (polite, only at start, the last minute and the end)", () => {
  const at = (phase: "running" | "final" | "finished", key = "a", durationMs = 300_000) => ({ key, phase, durationMs });
  it("says when a timer starts, with its length", () => {
    expect(timerAnnouncement(null, at("running"))).toBe("Timer started: 5 minutes.");
    // A replacement is a new start.
    expect(timerAnnouncement(at("running", "a"), at("running", "b", 60_000))).toBe("Timer started: 1 minute.");
  });
  it("says 1 minute left once, and time's up once", () => {
    expect(timerAnnouncement(at("running"), at("final"))).toBe(TIMER_TEXT.lastMinute);
    expect(timerAnnouncement(at("final"), at("final"))).toBeNull();
    expect(timerAnnouncement(at("final"), at("finished"))).toBe(TIMER_TEXT.finished);
    expect(timerAnnouncement(at("running"), at("finished"))).toBe(TIMER_TEXT.finished);
    expect(timerAnnouncement(at("finished"), at("finished"))).toBeNull();
  });
  it("says nothing on every other tick, or when it goes", () => {
    expect(timerAnnouncement(at("running"), at("running"))).toBeNull();
    expect(timerAnnouncement(at("running"), null)).toBeNull();
    expect(timerAnnouncement(null, null)).toBeNull();
  });
  it("joining while one is already in its last minute or done says where it is", () => {
    expect(timerAnnouncement(null, at("final"))).toBe(TIMER_TEXT.lastMinute);
    expect(timerAnnouncement(null, at("finished"))).toBe(TIMER_TEXT.finished);
  });
});

describe("durations", () => {
  it("presets are 1, 3, 5, 10, 15 and 30 minutes", () => {
    expect(TIMER_PRESETS_MIN).toEqual([1, 3, 5, 10, 15, 30]);
  });

  it("labels read naturally", () => {
    expect(durationLabel(60_000)).toBe("1 minute");
    expect(durationLabel(300_000)).toBe("5 minutes");
    expect(durationLabel(90_000)).toBe("1 minute 30 seconds");
    expect(durationLabel(30_000)).toBe("30 seconds");
    expect(durationLabel(1_000)).toBe("1 second");
    expect(durationLabel(TIMER_MAX_MS)).toBe("3 hours");
    expect(durationLabel(3_660_000)).toBe("1 hour 1 minute");
  });

  it("custom minutes: the relay's bounds (1 s to 3 h), decimals allowed, clear messages", () => {
    expect(parseMinutes("5")).toEqual({ ok: true, ms: 300_000 });
    expect(parseMinutes(" 2.5 ")).toEqual({ ok: true, ms: 150_000 });
    expect(parseMinutes("2,5")).toEqual({ ok: true, ms: 150_000 });
    expect(parseMinutes("180")).toEqual({ ok: true, ms: TIMER_MAX_MS });
    expect(parseMinutes(String(TIMER_MIN_MS / 60_000))).toEqual({ ok: true, ms: TIMER_MIN_MS });
    for (const bad of ["", "abc", "5 min", "-1", "0"]) {
      expect(parseMinutes(bad), bad).toMatchObject({ ok: false });
    }
    expect(parseMinutes("abc")).toEqual({ ok: false, error: TIMER_TEXT.notNumber });
    expect(parseMinutes("181")).toEqual({ ok: false, error: TIMER_TEXT.outOfRange });
    expect(parseMinutes("0.001")).toEqual({ ok: false, error: TIMER_TEXT.outOfRange });
    expect(TIMER_TEXT.outOfRange).toContain("3 hours");
  });

  it("Stop asks first only with more than a minute left", () => {
    expect(stopNeedsConfirm(60_001)).toBe(true);
    expect(stopNeedsConfirm(60_000)).toBe(false);
    expect(stopNeedsConfirm(0)).toBe(false);
  });
});
