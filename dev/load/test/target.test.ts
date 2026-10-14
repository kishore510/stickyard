import { describe, expect, it } from "vitest";
import { localTarget } from "../target";

// The load harness must never reach the deployed Worker or the Pages site: only a local relay.
describe("localTarget", () => {
  it.each(["http://127.0.0.1:8787", "http://localhost:8787", "http://[::1]:8787", "ws://127.0.0.1:8787/ws"])("accepts %s", (url) => {
    expect(localTarget(url).hostname).toMatch(/^(127\.0\.0\.1|localhost|\[::1\])$/);
  });

  it.each([
    "https://stickyard.example.workers.dev",
    "https://kishore510.github.io/stickyard/",
    "http://localhost.example.com:8787",
    "http://127.0.0.1.example.com",
    "http://user:pass@127.0.0.1:8787",
    "https://127.0.0.1:8787",
    "wss://localhost:8787",
    "http://10.0.0.5:8787",
    "http://0.0.0.0:8787",
    "not a url",
    "",
  ])("refuses %s", (url) => {
    expect(() => localTarget(url)).toThrow(/local/);
  });
});
