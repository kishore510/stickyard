import { afterEach, describe, expect, it, vi } from "vitest";
import { safeEqual } from "../src/crypto";
import { verifyRoomCode } from "../src/roomCode";
import { TEST_SIGNING_KEY, callWorker, createRequest, freshIp, specRoomCode } from "./helpers";

afterEach(() => {
  vi.restoreAllMocks();
});

/** Spies on the two WebCrypto calls a constant-time comparison must make. */
function spyCrypto() {
  const digest = vi.spyOn(crypto.subtle, "digest");
  const timingSafeEqual = vi.spyOn(crypto.subtle, "timingSafeEqual");
  /** Every timingSafeEqual call compared two buffers of the same, fixed length. */
  const comparedDigests = () =>
    timingSafeEqual.mock.calls.length > 0 &&
    timingSafeEqual.mock.calls.every(([a, b]) => a.byteLength === 32 && b.byteLength === 32);
  return { digest, timingSafeEqual, comparedDigests };
}

describe("safeEqual", () => {
  it("is true for equal strings and false otherwise", async () => {
    expect(await safeEqual("test-passcode", "test-passcode")).toBe(true);
    expect(await safeEqual("test-passcode", "test-passcodf")).toBe(false);
    expect(await safeEqual("", "")).toBe(true);
    expect(await safeEqual("é", "é")).toBe(false);
  });

  it("hashes both sides and compares the digests with timingSafeEqual", async () => {
    const { digest, timingSafeEqual, comparedDigests } = spyCrypto();
    await safeEqual("test-passcode", "test-passcode");
    expect(digest).toHaveBeenCalledTimes(2);
    expect(timingSafeEqual).toHaveBeenCalledTimes(1);
    expect(comparedDigests()).toBe(true);
  });

  it.each([
    ["shorter", "x"],
    ["longer", "test-passcode-and-then-some"],
    ["empty", ""],
  ])("does not short-circuit on a %s input", async (_label, other) => {
    const { digest, timingSafeEqual, comparedDigests } = spyCrypto();
    expect(await safeEqual("test-passcode", other)).toBe(false);
    expect(digest).toHaveBeenCalledTimes(2);
    expect(timingSafeEqual).toHaveBeenCalledTimes(1);
    expect(comparedDigests()).toBe(true);
  });
});

describe("comparisons go through the constant-time helper", () => {
  it.each([
    ["a wrong passcode of the same length", "test-passcodX"],
    ["a wrong passcode of a different length", "x"],
  ])("the passcode check, for %s", async (_label, passcode) => {
    const { timingSafeEqual, comparedDigests } = spyCrypto();
    const res = await callWorker(createRequest({ passcode }, { ip: freshIp() }));
    expect(res.status).toBe(401);
    expect(timingSafeEqual).toHaveBeenCalled();
    expect(comparedDigests()).toBe(true);
  });

  it("the room signature check, for a tampered signature", async () => {
    const { code } = await specRoomCode();
    const tampered = `${code.slice(0, -1)}${code.endsWith("A") ? "B" : "A"}`;
    const { timingSafeEqual, comparedDigests } = spyCrypto();
    expect(await verifyRoomCode(tampered, TEST_SIGNING_KEY)).toBeNull();
    expect(timingSafeEqual).toHaveBeenCalledTimes(1);
    expect(comparedDigests()).toBe(true);
  });
});
