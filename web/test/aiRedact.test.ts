import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { REDACTED, redact, rememberSecret } from "../src/ai/redact";

/*
 * One redaction module (AI part 1, v0.42.0): every error detail, console call and thrown message under
 * src/ai goes through it. It removes every key seen this visit, anything shaped sk-ant-..., and any
 * x-api-key value.
 */

const KEY = "sk-ant-api03-FAKE-redact-test-key-0000abcd";

describe("redact", () => {
  it("removes anything shaped like an Anthropic key", () => {
    expect(redact(`key ${KEY} here`)).toBe(`key ${REDACTED} here`);
    expect(redact("sk-ant-admin01-FAKE_x-y")).toBe(REDACTED);
    expect(redact("no keys here")).toBe("no keys here");
  });

  it("removes keys registered this visit, even when they don't look like one", () => {
    const odd = "FAKE-odd-shaped-registered-value-77";
    expect(redact(`got ${odd}!`)).toBe(`got ${odd}!`);
    rememberSecret(odd);
    expect(redact(`got ${odd}!`)).toBe(`got ${REDACTED}!`);
    expect(redact(`${odd}${odd}`)).toBe(`${REDACTED}${REDACTED}`);
  });

  it("ignores very short values so it never eats ordinary words", () => {
    rememberSecret("abc");
    rememberSecret("");
    expect(redact("abc abc")).toBe("abc abc");
  });

  it("removes the x-api-key value in header, JSON and query forms", () => {
    expect(redact("x-api-key: something-secret-1")).toBe(`x-api-key: ${REDACTED}`);
    expect(redact("X-Api-Key:something-secret-2\nnext")).toBe(`X-Api-Key:${REDACTED}\nnext`);
    expect(redact('{"x-api-key":"something-secret-3","a":1}')).toBe(`{"x-api-key":"${REDACTED}","a":1}`);
    expect(redact("{'x-api-key': 'something-secret-4'}")).toBe(`{'x-api-key': '${REDACTED}'}`);
    expect(redact("https://example.test/?x-api-key=something-secret-5&b=2")).toBe(`https://example.test/?x-api-key=${REDACTED}&b=2`);
    expect(redact("x_api_key=something-secret-6")).toBe(`x_api_key=${REDACTED}`);
  });

  it("handles a key inside JSON text and URL-encoded", () => {
    expect(redact(JSON.stringify({ message: `bad key ${KEY}` }))).not.toContain(KEY);
    rememberSecret(KEY);
    expect(redact(encodeURIComponent(`k=${KEY}`))).not.toContain(KEY);
  });
});

describe("nothing under src/ai writes to the console", () => {
  const dir = new URL("../src/ai/", import.meta.url).pathname;
  const files = (d: string): string[] =>
    readdirSync(d).flatMap((f) => {
      const p = join(d, f);
      return statSync(p).isDirectory() ? files(p) : [p];
    });

  it("has no console calls", () => {
    for (const file of files(dir)) expect(readFileSync(file, "utf8"), file).not.toMatch(/\bconsole\s*\./);
  });

  it("every thrown or detailed message goes through redact (no raw API message reaches the UI)", async () => {
    const spy = vi.spyOn(console, "error");
    const { errorDetails } = await import("../src/ai/messages");
    const details = errorDetails({ kind: "invalid_key", status: 401, type: "authentication_error", apiMessage: `invalid x-api-key ${KEY}`, requestId: "req_1" });
    expect(details).not.toContain(KEY);
    expect(details).toContain("401");
    expect(details).toContain("authentication_error");
    expect(details).toContain("req_1");
    expect(spy).not.toHaveBeenCalled();
  });
});
