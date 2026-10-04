/* Stub: tests first. */
export const FINAL_MS = 0;
export const FINISHED_HIDE_MS = 0;
export const TIMER_PRESETS_MIN: readonly number[] = [];
export const TIMER_TEXT = { lastMinute: "", finished: "", notNumber: "", outOfRange: "", replaces: "" };
export type TimerPhase = "running" | "final" | "finished";
export const remaining = (_t: { startedAt: number; durationMs: number }, _now: number, _offset: number) => -1;
export const formatRemaining = (_ms: number) => "";
export const timerPhase = (_ms: number): TimerPhase => "running";
export const chipVisible = (_t: { startedAt: number; durationMs: number } | null, _now: number, _offset: number) => false;
export const timerAnnouncement = (_p: { key: string; phase: TimerPhase; durationMs: number } | null, _n: { key: string; phase: TimerPhase; durationMs: number } | null): string | null => null;
export const durationLabel = (_ms: number) => "";
export const parseMinutes = (_text: string): { ok: true; ms: number } | { ok: false; error: string } => ({ ok: false, error: "" });
export const stopNeedsConfirm = (_ms: number) => false;
