import { ROOM_IDLE_EXPIRY_DAYS } from "@stickyard/shared";

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

/**
 * A noteBatch counts as one message against SOCKET_LIMITS, and its entries also count against
 * this per-socket budget. The web sends a live group drag of up to 50 notes at most every
 * 100 ms (500 entries a second), and final changes in chunks of 50, so a 200-note arrange (200
 * entries) fits the burst. Over-budget batches are dropped and count as violations, exactly as
 * for SOCKET_LIMITS.
 */
export const BATCH_LIMITS = {
  entriesPerSecond: 600,
  entriesBurst: 1000,
} as const;

/**
 * Live cursors (protocol v14) spend this per-socket bucket instead of SOCKET_LIMITS, so a moving
 * pointer can never starve edits or chat. The web sends at most 10 a second (one every 100 ms,
 * only after a move of at least 1 board unit), so 15/s with a burst of 20 leaves room for timer
 * jitter and a tab catching up. Over the budget a cursor message is dropped silently (the next
 * one supersedes it anyway). Only sustained abuse is a violation: past `maxSilentDrops` drops in
 * `dropWindowMs`, every further drop counts against SOCKET_LIMITS.maxViolations (and closes the
 * socket at 20, as for any other violation).
 */
export const CURSOR_LIMITS = {
  refillPerSecond: 15,
  burst: 20,
  maxSilentDrops: 100,
  dropWindowMs: 10_000,
} as const;

/**
 * Follow (protocol v19): viewports spend this per-socket bucket, never SOCKET_LIMITS or
 * CURSOR_LIMITS, so a followed person's panning can't starve their edits or chat. The web sends at
 * most 5 a second (one every 200 ms, only while followed and only when the view changed), so 10/s
 * with a burst of 10 leaves room for timer jitter. Over the budget a viewport is dropped and
 * counted as a violation (no reply): a page within the web's rate never gets there, and a flood
 * closes the socket at SOCKET_LIMITS.maxViolations like any other abuse.
 */
export const VIEWPORT_LIMITS = {
  refillPerSecond: 10,
  burst: 10,
} as const;

/**
 * Bring to me (protocol v19, host only): one every 5 seconds, bursts of 2. Each one moves
 * everyone's view, so it is kept tight. Over the budget: dropped with rate_limited to the sender,
 * as a violation.
 */
export const BRING_LIMITS = {
  refillPerSecond: 0.2,
  burst: 2,
} as const;

/**
 * Idle room expiry (worker/src/expiry.ts). When the last socket of a room closes, its alarm is
 * set this far ahead; when it fires with nobody connected, the room's data is deleted and a
 * tombstone kept. An existing alarm within ALARM_RESET_SLACK_MS of the new time is left alone,
 * so a script opening and closing sockets writes the alarm at most about once an hour.
 */
export const ROOM_IDLE_EXPIRY_MS = ROOM_IDLE_EXPIRY_DAYS * DAY;
export const ALARM_RESET_SLACK_MS = HOUR;
