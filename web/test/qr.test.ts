import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { correction, generate } from "lean-qr";
import { describe, expect, it } from "vitest";
import { roomLink } from "../src/rooms/link";
import { QR_MAX_VERSION, QR_QUIET_ZONE, encodeQr, qrPath } from "../src/share/qr";

/*
 * QR join (v0.32.0): the QR code is made on this device from the join link the app already
 * builds (rooms/link.ts roomLink), at error correction level M, up to QR_MAX_VERSION. Fixtures are
 * generic (test-room); nothing here is a real link.
 */

const ORIGIN = "https://example.test";
const BASE = "/stickyard/";
const link = roomLink("test-room", ORIGIN, BASE);

/** The modules as rows of 0/1, for comparing. */
const rows = (m: { size: number; dark: (x: number, y: number) => boolean }) =>
  Array.from({ length: m.size }, (_, y) => Array.from({ length: m.size }, (_, x) => (m.dark(x, y) ? 1 : 0)).join(""));

describe("encodeQr", () => {
  it("encodes exactly the given join link, at level M (the library's own output for that text)", () => {
    const m = encodeQr(link);
    expect(m).not.toBeNull();
    const reference = generate(link, { minCorrectionLevel: correction.M, maxCorrectionLevel: correction.M, maxVersion: QR_MAX_VERSION });
    expect(rows(m!)).toEqual(rows({ size: reference.size, dark: (x, y) => reference.get(x, y) }));
  });

  it("changes when the link changes", () => {
    const other = encodeQr(roomLink("other-room", ORIGIN, BASE));
    expect(rows(other!)).not.toEqual(rows(encodeQr(link)!));
    expect(rows(encodeQr(roomLink("test-room", "https://elsewhere.test", BASE))!)).not.toEqual(rows(encodeQr(link)!));
  });

  it("a link too long for the chosen version gives null, never a throw", () => {
    expect(() => encodeQr(`${ORIGIN}/${"x".repeat(400)}`)).not.toThrow();
    expect(encodeQr(`${ORIGIN}/${"x".repeat(400)}`)).toBeNull();
    expect(encodeQr("x".repeat(100_000))).toBeNull();
    expect(encodeQr("")).toBeNull();
  });

  it("a real-length join link fits well within the limit", () => {
    const code = `${"a".repeat(22)}.${"B".repeat(22)}`;
    const m = encodeQr(roomLink(code, "https://someone.github.io", "/stickyard/"));
    expect(m).not.toBeNull();
    expect(m!.size).toBeLessThanOrEqual(17 + 4 * QR_MAX_VERSION);
  });
});

describe("qrPath", () => {
  it("draws one unit square per dark module, offset by nothing (the quiet zone is in the viewBox)", () => {
    const m = { size: 2, dark: (x: number, y: number) => x === y };
    expect(qrPath(m)).toBe("M0 0h1v1h-1zM1 1h1v1h-1z");
  });

  it("is only path commands and numbers: nothing that could reference or run anything", () => {
    expect(qrPath(encodeQr(link)!)).toMatch(/^[MhvzZ0-9 -]+$/);
  });

  it("the quiet zone is four modules", () => {
    expect(QR_QUIET_ZONE).toBe(4);
  });
});

describe("QR join source", () => {
  const dir = new URL("../src/share/", import.meta.url).pathname;
  const source = readdirSync(dir).map((f) => readFileSync(join(dir, f), "utf8"));

  it("never logs, never stores, never fetches, never injects HTML", () => {
    for (const text of source) {
      expect(text).not.toMatch(/console\./);
      expect(text).not.toMatch(/localStorage|sessionStorage|writeKey|indexedDB/);
      expect(text).not.toMatch(/fetch\(|XMLHttpRequest|sendBeacon|new Image|WebSocket/);
      expect(text).not.toMatch(/dangerouslySetInnerHTML|innerHTML|toDataURL|toCanvas|<image|<img|href=/);
    }
  });
});
