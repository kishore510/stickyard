import { ALARM_RESET_SLACK_MS, ROOM_IDLE_EXPIRY_MS } from "./limits";

/*
 * Idle room expiry. When the last socket of a room closes, the room's alarm is set
 * ROOM_IDLE_EXPIRY_MS ahead (nextExpiryAlarm decides whether that needs a write). When it fires
 * with nobody connected, Room.alarm deletes everything (deleteAll; it also deletes the alarm at
 * our compatibility date, 2026-02-24 or later) and then writes one tombstone: the meta row
 * `expired_at`. A room with a tombstone never runs the normal schema init again; every socket
 * to it is accepted and closed at once with ROOM_EXPIRED_CLOSE_CODE and EXPIRED_REASON.
 *
 * The tombstone is a new key in the existing meta table, so the schema version is unchanged.
 */

/** The close reason that goes with ROOM_EXPIRED_CLOSE_CODE. */
export const EXPIRED_REASON = "expired";
/** Stub: tests first. */
export const ENDED_REASON = "";

/**
 * When to set the alarm after the last socket closes at `now`, or null to leave `existing`
 * alone (no write). An alarm already within ALARM_RESET_SLACK_MS of the new time, or later,
 * stays, so quick leave/join cycles cost no writes.
 */
export function nextExpiryAlarm(existing: number | null, now: number): number | null {
  const at = now + ROOM_IDLE_EXPIRY_MS;
  if (existing !== null && existing >= at - ALARM_RESET_SLACK_MS) return null;
  return at;
}

const hasMeta = (sql: SqlStorage) =>
  sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'meta'").one().n > 0;

/** When the room expired, or null if it hasn't. Reads only; never creates a table. */
export function readTombstone(sql: SqlStorage): number | null {
  if (!hasMeta(sql)) return null;
  const row = sql.exec<{ value: number }>("SELECT value FROM meta WHERE key = 'expired_at'").toArray()[0];
  return row ? row.value : null;
}

/**
 * Writes the tombstone into an emptied database (meta is created as noteStore.ts creates it).
 * Returns the rows written (the row and its primary-key index entry).
 */
export function writeTombstone(sql: SqlStorage, at: number): number {
  sql.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL)");
  const cursor = sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('expired_at', ?)", at);
  cursor.toArray();
  return cursor.rowsWritten;
}
