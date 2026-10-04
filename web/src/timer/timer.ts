import { TIMER_MAX_MS, TIMER_MIN_MS } from "@stickyard/shared";

/*
 * The room timer (facilitation UI, protocol v12 messages; web only). Pure, so tested. The relay
 * stores { startedAt, durationMs } by its own clock and sends serverNow with it; the page keeps
 * the offset (relay clock minus this device's) and works out what's left from timestamps on
 * every tick, never by counting down, so a throttled background tab is right when it comes back.
 */

/** The last minute: a text cue and a style change, announced once. */
export const FINAL_MS = 60_000;
/** A finished timer ("Time's up") stays this long, unless the host stops or replaces it, then hides here. */
export const FINISHED_HIDE_MS = 10 * 60_000;
/** The picker's presets, in minutes. */
export const TIMER_PRESETS_MIN: readonly number[] = [1, 3, 5, 10, 15, 30];

export const TIMER_TEXT = {
  lastMinute: "1 minute left.",
  lastMinuteCue: "Last minute",
  finished: "Time’s up.",
  finishedCue: "Time’s up",
  notNumber: "Type a number of minutes, like 5 or 2.5.",
  outOfRange: "A timer can run for 1 second to 3 hours (180 minutes).",
  replaces: "A timer is running. Starting a new one replaces it.",
  stopConfirm: "Stop the timer for everyone?",
} as const;

export type TimerPhase = "running" | "final" | "finished";

interface TimerSpan {
  startedAt: number;
  durationMs: number;
}

/**
 * Milliseconds left at this device's `now`, by the relay's clock (`offsetMs` = relay minus this
 * device). Never negative, and never more than the timer's length (a moment before its start by a
 * slightly-off offset still reads as the full length).
 */
export function remaining(timer: TimerSpan, now: number, offsetMs: number): number {
  return Math.min(timer.durationMs, Math.max(0, timer.startedAt + timer.durationMs - (now + offsetMs)));
}

const pad = (n: number) => String(n).padStart(2, "0");

/** mm:ss, or h:mm:ss from an hour; whole seconds rounded up, so 00:00 only at the end. */
export function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export function timerPhase(remainingMs: number): TimerPhase {
  if (remainingMs <= 0) return "finished";
  return remainingMs <= FINAL_MS ? "final" : "running";
}

/** Whether the chip shows: while running, and for FINISHED_HIDE_MS after the end. */
export function chipVisible(timer: TimerSpan | null, now: number, offsetMs: number): boolean {
  if (!timer) return false;
  return now + offsetMs < timer.startedAt + timer.durationMs + FINISHED_HIDE_MS;
}

/** What the timer is doing now, for announcements: which timer (`key`), its phase and length. */
export interface TimerMoment {
  key: string;
  phase: TimerPhase;
  durationMs: number;
}

/**
 * What to announce (politely) going from `prev` to `next`: a start (a new key), the last minute
 * and the end, once each. Nothing on other ticks or when the timer goes.
 */
export function timerAnnouncement(prev: TimerMoment | null, next: TimerMoment | null): string | null {
  if (!next) return null;
  const fresh = !prev || prev.key !== next.key;
  if (fresh) {
    if (next.phase === "running") return `Timer started: ${durationLabel(next.durationMs)}.`;
    return next.phase === "final" ? TIMER_TEXT.lastMinute : TIMER_TEXT.finished;
  }
  if (prev.phase === next.phase) return null;
  if (next.phase === "final") return TIMER_TEXT.lastMinute;
  return next.phase === "finished" ? TIMER_TEXT.finished : null;
}

const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "5 minutes", "1 minute 30 seconds", "1 hour 1 minute". */
export function durationLabel(ms: number): string {
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const parts = [h > 0 ? unit(h, "hour") : null, m > 0 ? unit(m, "minute") : null, s > 0 ? unit(s, "second") : null].filter((p) => p !== null);
  return parts.length > 0 ? parts.join(" ") : "0 seconds";
}

/** The picker's minutes field: decimals allowed (a comma too); within the relay's bounds, 1 second to 3 hours. */
export function parseMinutes(text: string): { ok: true; ms: number } | { ok: false; error: string } {
  const t = text.trim().replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(t) && !/^\.\d+$/.test(t)) return { ok: false, error: TIMER_TEXT.notNumber };
  const ms = Math.round(Number(t) * 60_000);
  if (!Number.isFinite(ms) || ms <= 0) return { ok: false, error: TIMER_TEXT.notNumber };
  if (ms < TIMER_MIN_MS || ms > TIMER_MAX_MS) return { ok: false, error: TIMER_TEXT.outOfRange };
  return { ok: true, ms };
}

/** Stop asks first only when more than a minute is left. */
export const stopNeedsConfirm = (remainingMs: number) => remainingMs > FINAL_MS;

/** Whether a duration is one the relay accepts (whole milliseconds, 1 s to 3 h). */
export const validDuration = (ms: number) => Number.isInteger(ms) && ms >= TIMER_MIN_MS && ms <= TIMER_MAX_MS;
