/*
 * The floating chat panel's size (md and up). Pure: limits, clamping to the room the canvas
 * has, the corner grip's drag, keyboard steps, and storage parsing. The panel is anchored at
 * the bottom right (above its button), so its grip is the top-left corner: dragging up and
 * left makes it bigger. Limits are mirrored in tokens.css (a test checks).
 */

export interface ChatSize {
  width: number;
  height: number;
}

export const CHAT_LIMITS = { minW: 256, minH: 240, maxW: 640 } as const;
/** Arrow keys on the grip change the size by this much; with Shift, by CHAT_STEP_BIG. */
export const CHAT_STEP = 10;
export const CHAT_STEP_BIG = 50;

const between = (value: number, lo: number, hi: number) => Math.min(Math.max(lo, hi), Math.max(lo, value));

/** Whole pixels, within the limits and within `room` (the space the dock has). */
export function clampChatSize(size: ChatSize, room: ChatSize): ChatSize {
  return {
    width: between(Math.round(size.width), CHAT_LIMITS.minW, Math.min(CHAT_LIMITS.maxW, room.width)),
    height: between(Math.round(size.height), CHAT_LIMITS.minH, room.height),
  };
}

/** `start` dragged by `delta` (pointer travel since the grip was grabbed). */
export function dragChatSize(start: ChatSize, delta: { x: number; y: number }, room: ChatSize): ChatSize {
  return clampChatSize({ width: start.width - delta.x, height: start.height - delta.y }, room);
}

const KEYS: Record<string, [number, number]> = { ArrowLeft: [1, 0], ArrowRight: [-1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };

export function chatKeyResize(size: ChatSize, key: string, big: boolean, room: ChatSize): ChatSize | null {
  const d = KEYS[key];
  if (!d) return null;
  const step = big ? CHAT_STEP_BIG : CHAT_STEP;
  return clampChatSize({ width: size.width + d[0] * step, height: size.height + d[1] * step }, room);
}

export function serialiseChatSize(size: ChatSize): string {
  return JSON.stringify({ width: size.width, height: size.height });
}

/** A stored size, or null (use the default) for anything missing or malformed. */
export function parseChatSize(raw: string | null): ChatSize | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    const { width, height } = value as Record<string, unknown>;
    if (typeof width !== "number" || typeof height !== "number" || !Number.isFinite(width) || !Number.isFinite(height)) return null;
    return { width: Math.round(width), height: Math.round(height) };
  } catch {
    return null;
  }
}
