import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CHAT_LIMITS, chatKeyResize, clampChatSize, dragChatSize, parseChatSize, serialiseChatSize } from "../src/chat/chatSize";
import { chatTime } from "../src/chat/time";
import { STORAGE_KEYS } from "../src/storage";

const tokens = readFileSync(join(new URL("../src/", import.meta.url).pathname, "styles/tokens.css"), "utf8");

describe("chat timestamps", () => {
  const at = new Date(2026, 9, 3, 14, 5, 9).getTime();

  it("today: the time only, with the full date and time for a tooltip and <time>", () => {
    const t = chatTime(at, new Date(2026, 9, 3, 18, 0).getTime());
    expect(t.short).toMatch(/14.05|2.05/);
    expect(t.short).not.toMatch(/2026/);
    expect(t.iso).toBe(new Date(at).toISOString());
    expect(t.full).toMatch(/2026/);
  });

  it("another day: the date too", () => {
    const t = chatTime(at, new Date(2026, 9, 5, 9, 0).getTime());
    expect(t.short).toMatch(/3/);
    expect(t.short).toMatch(/14.05|2.05/);
  });
});

describe("chat panel size", () => {
  const room = { width: 1000, height: 700 };

  it("limits are mirrored in tokens.css", () => {
    expect(tokens).toContain(`--sy-chat-min-w: ${CHAT_LIMITS.minW}px;`);
    expect(tokens).toContain(`--sy-chat-min-h: ${CHAT_LIMITS.minH}px;`);
    expect(tokens).toContain(`--sy-chat-max-w: ${CHAT_LIMITS.maxW}px;`);
  });

  it("clamps to the limits and the room available", () => {
    expect(clampChatSize({ width: 10, height: 10 }, room)).toEqual({ width: CHAT_LIMITS.minW, height: CHAT_LIMITS.minH });
    expect(clampChatSize({ width: 5000, height: 5000 }, room)).toEqual({ width: Math.min(CHAT_LIMITS.maxW, room.width), height: room.height });
    expect(clampChatSize({ width: 400.4, height: 380.6 }, room)).toEqual({ width: 400, height: 381 });
  });

  it("dragging the top-left grip up and left makes it bigger (it's anchored bottom right)", () => {
    expect(dragChatSize({ width: 352, height: 400 }, { x: -50, y: -30 }, room)).toEqual({ width: 402, height: 430 });
    expect(dragChatSize({ width: 352, height: 400 }, { x: 40, y: 20 }, room)).toEqual({ width: 312, height: 380 });
  });

  it("keyboard: Left/Up grow, Right/Down shrink, Shift for bigger steps", () => {
    const s = { width: 352, height: 400 };
    expect(chatKeyResize(s, "ArrowLeft", false, room)).toEqual({ width: 362, height: 400 });
    expect(chatKeyResize(s, "ArrowUp", true, room)).toEqual({ width: 352, height: 450 });
    expect(chatKeyResize(s, "ArrowRight", false, room)).toEqual({ width: 342, height: 400 });
    expect(chatKeyResize(s, "Enter", false, room)).toBeNull();
  });

  it("is saved as layout only, and anything odd in storage falls back to the default", () => {
    expect(STORAGE_KEYS.chatPanel).toBe("stickyard:chat-panel");
    expect(parseChatSize(serialiseChatSize({ width: 400, height: 380 }))).toEqual({ width: 400, height: 380 });
    expect(parseChatSize(null)).toBeNull();
    expect(parseChatSize("not json")).toBeNull();
    expect(parseChatSize('{"width":"x","height":3}')).toBeNull();
    expect(parseChatSize('{"width":400,"height":380,"extra":"<b>"}')).toEqual({ width: 400, height: 380 });
  });
});
