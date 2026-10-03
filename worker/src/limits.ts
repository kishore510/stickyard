/*
 * Abuse limits for room creation and per-connection message rates, in one place.
 * These are the project owner's chosen defaults; change them here.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const CREATE_LIMITS = {
  /** Failed passcode attempts allowed per client in `failureWindowMs`... */
  failuresPerClient: 5,
  failureWindowMs: 15 * MINUTE,
  /** ...after which that client is locked out for this long. */
  lockoutMs: 15 * MINUTE,
  /** Failed attempts across all clients in `globalFailureWindowMs` before everyone is refused. */
  globalFailures: 50,
  globalFailureWindowMs: HOUR,
  /** Successful room creations per client, per UTC day. */
  creationsPerClientPerDay: 5,
  /** Successful room creations across all clients, per UTC day. */
  creationsPerDay: 50,
  /** Limiter rows older than this are deleted when it next writes. */
  retentionMs: 2 * DAY,
} as const;

/**
 * Per-WebSocket token bucket: about 30 messages a second, bursts of 40. A note drag sends
 * about 20 a second (web/src/rooms/session.ts), so dragging stays well inside it.
 */
export const SOCKET_LIMITS = {
  refillPerSecond: 30,
  burst: 40,
  /** Over-limit messages within `violationWindowMs` before the socket is closed. */
  maxViolations: 20,
  violationWindowMs: 10_000,
} as const;
