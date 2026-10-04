/*
 * Reconnecting after a dropped room socket (web only). Pure rules with no timers or I/O of their
 * own: RoomSession runs them with its timers and the browser's online/offline and visibility
 * events (ConnectionEnv, swapped for a fake in tests).
 *
 * The schedule is exponential backoff with jitter, about 1, 2, 4, 8, 16, 30, 30, 30 seconds (about
 * two minutes in all), then it stops and offers Rejoin. Each try that reaches the relay costs one
 * Worker request and one Durable Object request (docs/LIMITS.md), so a flaky connection or a stuck
 * tab can never loop: at most RECONNECT_MAX_ATTEMPTS tries per drop, none while the tab has been
 * hidden for long, and one cheap health probe a minute (for at most an hour) while the relay looks
 * down.
 */

/** The first delay; each later one doubles. */
export const RECONNECT_BASE_MS = 1000;
/** No delay is longer than this. */
export const RECONNECT_MAX_DELAY_MS = 30_000;
/** Each delay is the base ±20%, so many pages reconnecting at once spread out. */
export const RECONNECT_JITTER = 0.2;
/** Automatic tries per drop; then Rejoin (or the network coming back) starts again. */
export const RECONNECT_MAX_ATTEMPTS = 8;
/** After this many sockets in a row that never opened, ask GET /health why. */
export const PROBE_AFTER_FAILED_OPENS = 3;
/** While the relay looks down (or over its daily limit): one health probe this often, while visible. */
export const LIMIT_RETRY_MS = 60_000;
/** Probes while it looks down before giving up (an hour). */
export const LIMIT_MAX_PROBES = 60;
/** A hidden tab keeps trying this long, then waits until it's visible again. */
export const HIDDEN_GRACE_MS = 60_000;
/** Tries started by browser events (online, visible) are at least this far apart. */
export const MIN_TRY_GAP_MS = 1000;

/** What a health probe says: the relay answers (same protocol), is down or unreachable, or is newer than this page. */
export type ProbeResult = "ok" | "down" | "reload";

/** The browser's network and visibility state, and its events. */
export interface ConnectionEnv {
  online(): boolean;
  hidden(): boolean;
  /** Starts listening; returns a function that stops. */
  listen(on: { online(): void; offline(): void; visibility(): void }): () => void;
}

/** Always online and visible, and never tells anything (the default where there's no browser). */
export const STATIC_ENV: ConnectionEnv = { online: () => true, hidden: () => false, listen: () => () => {} };

/** The real browser: navigator.onLine, document.hidden and their events. */
export const browserConnectionEnv: ConnectionEnv = {
  online: () => (typeof navigator === "undefined" ? true : navigator.onLine !== false),
  hidden: () => (typeof document === "undefined" ? false : document.visibilityState === "hidden"),
  listen: (on) => {
    if (typeof window === "undefined") return () => {};
    const online = () => on.online();
    const offline = () => on.offline();
    const visibility = () => on.visibility();
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
      document.removeEventListener("visibilitychange", visibility);
    };
  },
};

/** The delay before try `attempt` (1-based) without jitter: 1 s doubling, capped at 30 s. */
export function backoffBase(attempt: number): number {
  const n = Math.max(1, Math.floor(attempt));
  return Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_MS * 2 ** Math.min(n - 1, 30));
}

/** The delay before try `attempt`, with ±20% jitter from `random` (0..1), never above the cap. */
export function backoffDelay(attempt: number, random: () => number): number {
  const raw = random();
  const r = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0.5;
  const factor = 1 - RECONNECT_JITTER + 2 * RECONNECT_JITTER * r;
  return Math.min(RECONNECT_MAX_DELAY_MS, Math.round(backoffBase(attempt) * factor));
}

/** After try `attempt` failed: try again, or stop and offer Rejoin. */
export function afterFailedTry(attempt: number, max: number = RECONNECT_MAX_ATTEMPTS): "retry" | "give-up" {
  return attempt >= max ? "give-up" : "retry";
}

/** Whether to probe the relay's health after this many sockets in a row failed to open. */
export function shouldProbe(failedOpens: number): boolean {
  return failedOpens >= PROBE_AFTER_FAILED_OPENS;
}

/** Whether an automatic try may run now: always while visible, and for a short while after the tab was hidden. */
export function mayTryWhileHidden(hiddenSince: number | null, now: number): boolean {
  return hiddenSince === null || now - hiddenSince <= HIDDEN_GRACE_MS;
}
