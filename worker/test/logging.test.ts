/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";

/*
 * Logging hygiene: Worker code must not log request bodies, names, text, passcodes,
 * room codes, tokens or IP addresses. The simplest rule that guarantees it: no `console.`
 * at all in worker/src, except in files on this allow-list (empty today). Adding a file
 * here needs a review of everything it logs.
 */
const ALLOWED: string[] = [];

const sources = import.meta.glob<string>("../src/**/*.ts", { query: "?raw", import: "default", eager: true });

describe("worker logging", () => {
  it("finds the worker sources", () => {
    expect(Object.keys(sources)).toContain("../src/index.ts");
    expect(Object.keys(sources).length).toBeGreaterThan(5);
  });

  it("has no console.* outside the allow-list", () => {
    for (const [path, text] of Object.entries(sources)) {
      if (ALLOWED.includes(path)) continue;
      expect(text.match(/\bconsole\s*(\.|\[)/g) ?? [], path).toEqual([]);
    }
  });
});
