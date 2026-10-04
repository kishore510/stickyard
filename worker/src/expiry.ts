import { ALARM_RESET_SLACK_MS, ROOM_IDLE_EXPIRY_MS } from "./limits";

/*
 * Idle room expiry, and End session (protocol v12). When the last socket of a room closes, the
 * room's alarm is set ROOM_IDLE_EXPIRY_MS ahead (nextExpiryAlarm decides whether that needs a
 * write). When it fires with nobody connected, or when a host ends the session, the room is
 * buried in three steps (Room.bury):
 *   1. one synchronous transaction: every table but meta dropped, meta emptied, the tombstone
 *      written (clearToTombstone), so the data can't outlive the tombstone;
 *   2. deleteAll(), for everything else (KV, freed pages, and the alarm at our compatibility
 *      date, 2026-02-24 or later), which removes the tombstone too;
 *   3. the tombstone written again.
 * A crash between 2 and 3 leaves an empty database: the room would come back as new and empty,
 * never with its old data.
 *
 * Tombstones are meta rows: `expired_at` (close code ROOM_EXPIRED_CLOSE_CODE, "expired") or
 * `ended_at` (ROOM_ENDED_CLOSE_CODE, "ended"). A room with one never runs the normal schema init
 * again; every socket to it is accepted and closed at once. New meta keys, so the schema version
 * is unchanged.
 */

/** The close reason that goes with ROOM_EXPIRED_CLOSE_CODE. */
export const EXPIRED_REASON = "expired";
/** The close reason that goes with ROOM_ENDED_CLOSE_CODE (a host ended the session, protocol v12). */
export const ENDED_REASON = "ended";

/** Why a room is gone: it expired (idle), or a host ended it. Each has its own meta key. */
export type TombstoneKind = "expired" | "ended";
export interface Tombstone {
  kind: TombstoneKind;
  at: number;
}
const KEYS: Record<TombstoneKind, string> = { expired: "expired_at", ended: "ended_at" };

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

/** The room's tombstone, or null if it is alive. Reads only; never creates a table. */
export function readTombstone(sql: SqlStorage): Tombstone | null {
  if (!hasMeta(sql)) return null;
  const rows = sql.exec<{ key: string; value: number }>("SELECT key, value FROM meta WHERE key IN ('expired_at', 'ended_at')").toArray();
  const ended = rows.find((r) => r.key === KEYS.ended);
  if (ended) return { kind: "ended", at: ended.value };
  const expired = rows.find((r) => r.key === KEYS.expired);
  return expired ? { kind: "expired", at: expired.value } : null;
}

/**
 * Step 1 of burying a room, synchronous (the caller runs it in transactionSync): drops every
 * table but meta (notes, frames, and anything later), empties meta (schema version, lock, timer)
 * and writes the tombstone. Data goes and the tombstone appears together, or neither does.
 * Returns the rows written.
 */
export function clearToTombstone(sql: SqlStorage, tombstone: Tombstone): number {
  const tables = sql
    .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'meta'")
    .toArray()
    .map((t) => t.name);
  for (const name of tables) sql.exec(`DROP TABLE IF EXISTS "${name.replaceAll('"', '""')}"`);
  let rows = 0;
  if (hasMeta(sql)) {
    const cleared = sql.exec("DELETE FROM meta");
    cleared.toArray();
    rows += cleared.rowsWritten;
  }
  return rows + writeTombstone(sql, tombstone);
}

/**
 * Writes the tombstone (meta is created as noteStore.ts creates it). Also step 3, after
 * deleteAll() has removed everything, the tombstone included. Returns the rows written.
 */
export function writeTombstone(sql: SqlStorage, tombstone: Tombstone): number {
  sql.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL)");
  const cursor = sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", KEYS[tombstone.kind], tombstone.at);
  cursor.toArray();
  return cursor.rowsWritten;
}
