/** Idle room expiry. Stub: tests first. */
export const EXPIRED_REASON = "expired";

export function nextExpiryAlarm(_existing: number | null, _now: number): number | null {
  return null;
}

export function readTombstone(_sql: SqlStorage): number | null {
  return null;
}
