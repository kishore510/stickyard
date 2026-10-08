import { describe, expect, it } from "vitest";
import {
  BOARD_WRITES,
  HOST_ONLY,
  MAX_NAME_LENGTH,
  MAX_PARTICIPANTS,
  PROTOCOL_VERSION,
  ROOM_ENDED_CLOSE_CODE,
  ROOM_EXPIRED_CLOSE_CODE,
  TIMER_MAX_MS,
  TIMER_MIN_MS,
  clientMessageSchema,
  createRoomResponseSchema,
  encodeMessage,
  serverMessageSchema,
  utf8Length,
} from "../src";

/* Protocol v12 (slice host): host token, lock, timer, End session. */

const ID = "AAAAAAAAAAAAAAAA";
const TOKEN = "T".repeat(43);

describe("protocol v12", () => {
  it("is version 12, with 4411 next to 4410", () => {
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(12);
    expect(ROOM_EXPIRED_CLOSE_CODE).toBe(4410);
    expect(ROOM_ENDED_CLOSE_CODE).toBe(4411);
  });

  it("every client message type is classified as changing the board or not", () => {
    const types = clientMessageSchema.options.map((o) => o.shape.type.value).sort();
    expect(Object.keys(BOARD_WRITES).sort()).toEqual(types);
    for (const t of HOST_ONLY) expect(BOARD_WRITES[t]).toBe(false);
  });

  it("client messages are strict", () => {
    expect(clientMessageSchema.safeParse({ type: "claimHost", token: TOKEN }).success).toBe(true);
    expect(clientMessageSchema.safeParse({ type: "claimHost", token: TOKEN, host: true }).success).toBe(false);
    expect(clientMessageSchema.safeParse({ type: "claimHost", token: "short" }).success).toBe(false);
    expect(clientMessageSchema.safeParse({ type: "lockSet", locked: true }).success).toBe(true);
    expect(clientMessageSchema.safeParse({ type: "lockSet", locked: "yes" }).success).toBe(false);
    expect(clientMessageSchema.safeParse({ type: "timerStop" }).success).toBe(true);
    expect(clientMessageSchema.safeParse({ type: "timerStop", at: 1 }).success).toBe(false);
    expect(clientMessageSchema.safeParse({ type: "endSession" }).success).toBe(true);
    expect(clientMessageSchema.safeParse({ type: "endSession", force: true }).success).toBe(false);
  });

  it("timer durations: 1 s to 3 h, whole milliseconds", () => {
    const ok = (durationMs: number) => clientMessageSchema.safeParse({ type: "timerStart", durationMs }).success;
    expect(ok(TIMER_MIN_MS)).toBe(true);
    expect(ok(TIMER_MAX_MS)).toBe(true);
    expect(ok(TIMER_MIN_MS - 1)).toBe(false);
    expect(ok(TIMER_MAX_MS + 1)).toBe(false);
    expect(ok(60_000.5)).toBe(false);
    expect(TIMER_MAX_MS).toBe(3 * 60 * 60 * 1000);
  });

  it("server messages parse", () => {
    const me = { id: ID, name: "Alex", colourIndex: 0, host: true };
    for (const m of [
      { type: "hostGranted" },
      { type: "participantUpdated", participant: me },
      { type: "lockChanged", locked: true },
      { type: "timerChanged", timer: null },
      { type: "timerChanged", timer: { startedAt: 1000, durationMs: 60_000, serverNow: 2000 } },
      { type: "sessionEnded" },
      { type: "error", code: "board_locked", message: "Locked.", noteIds: ["NNNNNNNNNNNNNNN1"] },
      { type: "error", code: "not_host", message: "Host only." },
      { type: "error", code: "bad_host_token", message: "No." },
      { type: "joined", you: me, participants: [me], locked: true, timer: { startedAt: 1, durationMs: 1000, serverNow: 2 }, voting: { state: "off", budget: 5, round: 0 }, silent: { active: false, count: 0 } },
    ]) {
      expect(serverMessageSchema.safeParse(m).success, JSON.stringify(m)).toBe(true);
    }
    // Participants must say whether they're host; joined must carry the lock and the timer.
    expect(serverMessageSchema.safeParse({ type: "participant_joined", participant: { id: ID, name: "Alex", colourIndex: 0 } }).success).toBe(false);
    expect(serverMessageSchema.safeParse({ type: "joined", you: me, participants: [me] }).success).toBe(false);
  });

  it("POST /rooms answers with a 43-character host token", () => {
    const code = `${"a".repeat(22)}.${"B".repeat(22)}`;
    expect(createRoomResponseSchema.safeParse({ code, hostToken: TOKEN }).success).toBe(true);
    expect(createRoomResponseSchema.safeParse({ code }).success).toBe(false);
    expect(createRoomResponseSchema.safeParse({ code, hostToken: "x" }).success).toBe(false);
  });

  it("the largest joined (20 hosts with 24-emoji names, a timer at its widest) stays under 8 KiB", () => {
    const people = Array.from({ length: MAX_PARTICIPANTS }, (_, i) => ({ id: ID, name: "😀".repeat(MAX_NAME_LENGTH), colourIndex: i, host: true }));
    const big = Number.MAX_SAFE_INTEGER;
    const raw = encodeMessage({ type: "joined", you: people[0]!, participants: people, locked: true, timer: { startedAt: big, durationMs: TIMER_MAX_MS, serverNow: big }, voting: { state: "closed", budget: 20, round: big }, silent: { active: false, count: 0 } });
    expect(serverMessageSchema.safeParse(JSON.parse(raw)).success).toBe(true);
    expect(utf8Length(raw)).toBeLessThan(8 * 1024);
  });
});
