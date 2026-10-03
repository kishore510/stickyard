import { DurableObject } from "cloudflare:workers";
import { base64url, hmacSha256 } from "./crypto";
import type { WorkerEnv } from "./env";
import { CREATE_LIMITS } from "./limits";

/** The one limiter instance's name. */
export const LIMITER_NAME = "global";

export type Decision = { outcome: "created" } | { outcome: "invalid" } | { outcome: "limited"; retryAfterSeconds: number };

const DAY = 24 * 60 * 60 * 1000;

/**
 * The limiter's key for a client: a truncated HMAC of its IP address, so raw IPs are never
 * stored. Domain-separated from room signatures, keyed by ROOM_SIGNING_KEY.
 */
export async function clientKey(ip: string, signingKey: string): Promise<string> {
  return base64url((await hmacSha256(signingKey, `stickyard-client-v1:${ip}`)).slice(0, 12));
}

const limited = (untilMs: number, now: number): Decision => ({
  outcome: "limited",
  retryAfterSeconds: Math.max(1, Math.ceil((untilMs - now) / 1000)),
});

/**
 * Room-creation abuse counters, in one SQLite-backed Durable Object (fixed name).
 * Reads on every attempt; writes only when a counter changes (a failure, a lockout,
 * a successful creation), and prunes old rows at the same time.
 */
export class Limiter extends DurableObject<WorkerEnv> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: WorkerEnv) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS failures (client TEXT NOT NULL, ts INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS failures_client_ts ON failures (client, ts);
      CREATE INDEX IF NOT EXISTS failures_ts ON failures (ts);
      CREATE TABLE IF NOT EXISTS lockouts (client TEXT PRIMARY KEY, until INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS creations (
        client TEXT NOT NULL, day INTEGER NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (client, day)
      );
    `);
  }

  /**
   * One creation attempt by `client` at time `now`. `passcodeOk` says whether the passcode
   * matched. Only a failed passcode adds a failure; only a granted creation adds a creation.
   */
  attempt(client: string, passcodeOk: boolean, now: number): Decision {
    const L = CREATE_LIMITS;

    const lock = this.sql.exec<{ until: number }>("SELECT until FROM lockouts WHERE client = ? AND until > ?", client, now).toArray()[0];
    if (lock) return limited(lock.until, now);

    const global = this.sql
      .exec<{ n: number; oldest: number | null }>(
        "SELECT COUNT(*) AS n, MIN(ts) AS oldest FROM failures WHERE ts > ?",
        now - L.globalFailureWindowMs,
      )
      .one();
    if (global.n >= L.globalFailures && global.oldest !== null) {
      return limited(global.oldest + L.globalFailureWindowMs, now);
    }

    if (!passcodeOk) {
      this.prune(now);
      this.sql.exec("INSERT INTO failures (client, ts) VALUES (?, ?)", client, now);
      const mine = this.sql
        .exec<{ n: number }>("SELECT COUNT(*) AS n FROM failures WHERE client = ? AND ts > ?", client, now - L.failureWindowMs)
        .one();
      if (mine.n >= L.failuresPerClient) {
        this.sql.exec("INSERT OR REPLACE INTO lockouts (client, until) VALUES (?, ?)", client, now + L.lockoutMs);
      }
      return { outcome: "invalid" };
    }

    const day = Math.floor(now / DAY);
    const midnight = (day + 1) * DAY;
    const mine = this.sql.exec<{ count: number }>("SELECT count FROM creations WHERE client = ? AND day = ?", client, day).toArray()[0];
    if ((mine?.count ?? 0) >= L.creationsPerClientPerDay) return limited(midnight, now);
    const total = this.sql.exec<{ n: number | null }>("SELECT SUM(count) AS n FROM creations WHERE day = ?", day).one();
    if ((total.n ?? 0) >= L.creationsPerDay) return limited(midnight, now);

    this.prune(now);
    this.sql.exec(
      "INSERT INTO creations (client, day, count) VALUES (?, ?, 1) ON CONFLICT (client, day) DO UPDATE SET count = count + 1",
      client,
      day,
    );
    return { outcome: "created" };
  }

  /** Deletes rows older than the retention period. Runs only alongside a write. */
  private prune(now: number): void {
    const cutoff = now - CREATE_LIMITS.retentionMs;
    this.sql.exec("DELETE FROM failures WHERE ts < ?", cutoff);
    this.sql.exec("DELETE FROM lockouts WHERE until < ?", now);
    this.sql.exec("DELETE FROM creations WHERE day < ?", Math.floor(cutoff / DAY));
  }
}
