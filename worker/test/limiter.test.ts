import { exports } from "cloudflare:workers";
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { CREATE_LIMITS } from "../src/limits";
import { LIMITER_NAME, clientKey, type Decision } from "../src/limiter";
import { TEST_PASSCODE, TEST_SIGNING_KEY, createRequest, freshIp } from "./helpers";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A limiter instance of its own, so tests don't share counters. */
function limiter() {
  return env.LIMITER.getByName(`test-${crypto.randomUUID()}`);
}

/** A distinct UTC day per call, at 10:00, far from the real clock. */
let dayCounter = 0;
const freshDay = () => Date.UTC(2031, 0, 1 + dayCounter++, 10);

const attempt = (stub: ReturnType<typeof limiter>, client: string, ok: boolean, now: number): Promise<Decision> =>
  stub.attempt(client, ok, now);

describe("limits config", () => {
  it("holds the chosen defaults", () => {
    expect(CREATE_LIMITS).toMatchObject({
      failuresPerClient: 5,
      failureWindowMs: 15 * MINUTE,
      lockoutMs: 15 * MINUTE,
      globalFailures: 50,
      globalFailureWindowMs: HOUR,
      creationsPerClientPerDay: 5,
      creationsPerDay: 50,
      retentionMs: 2 * DAY,
    });
  });
});

describe("failed passcode attempts", () => {
  it("the 6th failed attempt in the window is locked out with a retry time", async () => {
    const stub = limiter();
    const t = freshDay();
    for (let i = 0; i < 5; i++) expect(await attempt(stub, "client-a", false, t + i * MINUTE)).toEqual({ outcome: "invalid" });
    const sixth = await attempt(stub, "client-a", false, t + 5 * MINUTE);
    expect(sixth.outcome).toBe("limited");
    if (sixth.outcome !== "limited") return;
    // Locked for 15 minutes from the 5th failure (at t + 4 min).
    expect(sixth.retryAfterSeconds).toBe(14 * 60);
  });

  it("a correct passcode is refused during the lockout too", async () => {
    const stub = limiter();
    const t = freshDay();
    for (let i = 0; i < 5; i++) await attempt(stub, "client-a", false, t);
    expect((await attempt(stub, "client-a", true, t + MINUTE)).outcome).toBe("limited");
  });

  it("the lockout ends after 15 minutes", async () => {
    const stub = limiter();
    const t = freshDay();
    for (let i = 0; i < 5; i++) await attempt(stub, "client-a", false, t);
    expect((await attempt(stub, "client-a", false, t + 15 * MINUTE - 1000)).outcome).toBe("limited");
    expect((await attempt(stub, "client-a", true, t + 15 * MINUTE)).outcome).toBe("created");
  });

  it("failures spread wider than the window don't lock out", async () => {
    const stub = limiter();
    const t = freshDay();
    for (let i = 0; i < 8; i++) {
      expect((await attempt(stub, "client-a", false, t + i * 4 * MINUTE)).outcome).toBe("invalid");
    }
  });

  it("successful attempts do not count as failures", async () => {
    const stub = limiter();
    const t = freshDay();
    for (let i = 0; i < 4; i++) await attempt(stub, "client-a", false, t);
    for (let i = 0; i < 3; i++) expect((await attempt(stub, "client-a", true, t)).outcome).toBe("created");
    expect((await attempt(stub, "client-a", false, t)).outcome).toBe("invalid");
    expect((await attempt(stub, "client-a", false, t)).outcome).toBe("limited");
  });

  it("one client's failures don't lock out another", async () => {
    const stub = limiter();
    const t = freshDay();
    for (let i = 0; i < 6; i++) await attempt(stub, "client-a", false, t);
    expect((await attempt(stub, "client-b", true, t)).outcome).toBe("created");
  });

  it("50 failures in an hour across all clients refuse everyone", async () => {
    const stub = limiter();
    const t = freshDay();
    for (let i = 0; i < 50; i++) {
      expect((await attempt(stub, `client-${i}`, false, t + i * 1000)).outcome).toBe("invalid");
    }
    const refused = await attempt(stub, "client-new", true, t + 50 * 1000);
    expect(refused.outcome).toBe("limited");
    if (refused.outcome === "limited") expect(refused.retryAfterSeconds).toBe(3600 - 50);
    // An hour after the first failure, it starts letting people in again.
    expect((await attempt(stub, "client-new", true, t + HOUR + 1000)).outcome).toBe("created");
  });
});

describe("room creations", () => {
  it("5 per client per UTC day, then refused until midnight UTC", async () => {
    const stub = limiter();
    const t = freshDay(); // 10:00 UTC
    for (let i = 0; i < 5; i++) expect((await attempt(stub, "client-a", true, t)).outcome).toBe("created");
    const sixth = await attempt(stub, "client-a", true, t);
    expect(sixth.outcome).toBe("limited");
    if (sixth.outcome === "limited") expect(sixth.retryAfterSeconds).toBe(14 * 3600);
  });

  it("50 per UTC day across all clients", async () => {
    const stub = limiter();
    const t = freshDay();
    for (let c = 0; c < 10; c++) {
      for (let i = 0; i < 5; i++) expect((await attempt(stub, `client-${c}`, true, t)).outcome).toBe("created");
    }
    expect((await attempt(stub, "client-new", true, t)).outcome).toBe("limited");
  });

  it("a refused creation is not counted", async () => {
    const stub = limiter();
    const t = freshDay();
    for (let i = 0; i < 5; i++) await attempt(stub, "client-a", true, t);
    for (let i = 0; i < 3; i++) await attempt(stub, "client-a", true, t);
    const count = await runInDurableObject(stub, (_instance, state) => {
      const row = state.storage.sql
        .exec<{ n: number }>("SELECT SUM(count) AS n FROM creations")
        .one();
      return row.n;
    });
    expect(count).toBe(5);
  });

  it("counters reset on a new UTC day", async () => {
    const stub = limiter();
    const t = freshDay();
    for (let i = 0; i < 5; i++) await attempt(stub, "client-a", true, t);
    expect((await attempt(stub, "client-a", true, t)).outcome).toBe("limited");
    const nextDay = Date.UTC(new Date(t).getUTCFullYear(), new Date(t).getUTCMonth(), new Date(t).getUTCDate() + 1, 0, 0, 1);
    expect((await attempt(stub, "client-a", true, nextDay)).outcome).toBe("created");
  });

  it("failures don't use up the creation allowance", async () => {
    const stub = limiter();
    const t = freshDay();
    for (let i = 0; i < 4; i++) await attempt(stub, "client-a", false, t);
    for (let i = 0; i < 5; i++) expect((await attempt(stub, "client-a", true, t)).outcome).toBe("created");
  });
});

describe("storage", () => {
  it("refused attempts don't write anything", async () => {
    const stub = limiter();
    const t = freshDay();
    for (let i = 0; i < 5; i++) await attempt(stub, "client-a", false, t);
    const snapshot = () =>
      runInDurableObject(stub, (_i, state) =>
        JSON.stringify([
          state.storage.sql.exec("SELECT * FROM failures ORDER BY rowid").toArray(),
          state.storage.sql.exec("SELECT * FROM lockouts").toArray(),
          state.storage.sql.exec("SELECT * FROM creations").toArray(),
        ]),
      );
    const before = await snapshot();
    for (let i = 0; i < 3; i++) {
      await attempt(stub, "client-a", false, t + MINUTE);
      await attempt(stub, "client-a", true, t + MINUTE);
    }
    expect(await snapshot()).toBe(before);
  });

  it("deletes rows older than 2 days when it next writes", async () => {
    const stub = limiter();
    const t = freshDay();
    await attempt(stub, "old-client", false, t);
    await attempt(stub, "old-client", true, t);
    await attempt(stub, "new-client", false, t + 3 * DAY);
    const rows = await runInDurableObject(stub, (_i, state) => ({
      failures: state.storage.sql.exec<{ client: string }>("SELECT client FROM failures").toArray(),
      creations: state.storage.sql.exec<{ client: string }>("SELECT client FROM creations").toArray(),
    }));
    expect(rows.failures).toEqual([{ client: "new-client" }]);
    expect(rows.creations).toEqual([]);
  });

  it("client keys are a truncated HMAC of the IP, never the IP", async () => {
    const ip = "198.51.100.23";
    const key = await clientKey(ip, TEST_SIGNING_KEY);
    expect(key).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(key).not.toContain(ip);
    expect(await clientKey(ip, TEST_SIGNING_KEY)).toBe(key);
    expect(await clientKey("198.51.100.24", TEST_SIGNING_KEY)).not.toBe(key);
    expect(await clientKey(ip, "another-test-key")).not.toBe(key);
  });

  it("requests through the Worker store hashed keys, never raw IPs", async () => {
    const ip = freshIp();
    await exports.default.fetch(createRequest({ passcode: "wrong-passcode" }, { ip }));
    await exports.default.fetch(createRequest({ passcode: TEST_PASSCODE }, { ip }));
    const expected = await clientKey(ip, TEST_SIGNING_KEY);
    const dump = await runInDurableObject(env.LIMITER.getByName(LIMITER_NAME), (_i, state) => {
      const tables = state.storage.sql
        .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'")
        .toArray()
        .map((r) => r.name);
      return tables.map((t) => JSON.stringify(state.storage.sql.exec(`SELECT * FROM "${t}"`).toArray())).join("\n");
    });
    expect(dump).toContain(expected);
    expect(dump).not.toContain(ip);
  });
});

describe("through the Worker", () => {
  it("5 wrong passcodes get 401, the 6th gets 429 with Retry-After", async () => {
    const ip = freshIp();
    for (let i = 0; i < 5; i++) {
      const res = await exports.default.fetch(createRequest({ passcode: "wrong-passcode" }, { ip }));
      expect(res.status).toBe(401);
    }
    const res = await exports.default.fetch(createRequest({ passcode: "wrong-passcode" }, { ip }));
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "rate_limited" });
    const retryAfter = Number(res.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThan(14 * 60);
    expect(retryAfter).toBeLessThanOrEqual(15 * 60);

    // Even the right passcode is refused while locked out.
    const right = await exports.default.fetch(createRequest({ passcode: TEST_PASSCODE }, { ip }));
    expect(right.status).toBe(429);
  });
});
