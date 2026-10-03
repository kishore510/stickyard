import { PROTOCOL_VERSION } from "@stickyard/shared";
import { describe, expect, it } from "vitest";
import { CREDITS } from "../src/about/credits";
import { formatDetails, VERSION_INFO } from "../src/version";

describe("VERSION_INFO", () => {
  it("is injected at build time", () => {
    expect(VERSION_INFO.version).toMatch(/^0\.\d+\.\d+$/);
    expect(VERSION_INFO.commit).toMatch(/^([0-9a-f]{4,40}|dev)$/);
    expect(new Date(VERSION_INFO.buildDate).toISOString()).toBe(VERSION_INFO.buildDate);
    expect(VERSION_INFO.protocolVersion).toBe(PROTOCOL_VERSION);
  });
});

describe("formatDetails (Copy details)", () => {
  it("contains only version, build, protocol and browser", () => {
    const text = formatDetails({ version: "0.2.0", commit: "abc1234", buildDate: "2026-10-03T10:00:00.000Z", protocolVersion: 1 }, "TestAgent/1.0");
    expect(text.split("\n")).toEqual(["Stickyard 0.2.0", "Build: abc1234", "Protocol: v1", "Browser: TestAgent/1.0"]);
  });

  it("says unknown for a missing browser", () => {
    expect(formatDetails(VERSION_INFO, "")).toContain("Browser: unknown");
  });
});

describe("credits", () => {
  it("names the real dependencies with a licence and purpose", () => {
    const byName = new Map(CREDITS.map((c) => [c.name, c]));
    for (const name of ["react", "zustand", "tailwindcss", "zod", "vite", "@fontsource-variable/inter", "lucide-react"]) {
      const credit = byName.get(name);
      expect(credit, name).toBeDefined();
      expect(credit?.license, name).toMatch(/^(MIT|ISC|OFL-1\.1|Apache-2\.0)$/);
      expect(credit?.role.length, name).toBeGreaterThan(5);
    }
  });
});
