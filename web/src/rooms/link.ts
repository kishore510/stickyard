import { isRoomCodeShape } from "@stickyard/shared";

/** Longest paste we look at. A full link is well under this. */
const MAX_INPUT = 2000;
const ROOM_PATH = /^(?:\S*#)?\/room\/([^\s/?#]+)$/;

/** The room code from a pasted link (full, hash-only) or a bare code; null if there isn't one. */
export function parseJoinInput(input: string): string | null {
  if (input.length > MAX_INPUT) return null;
  const value = input.trim();
  if (isRoomCodeShape(value)) return value;
  const code = ROOM_PATH.exec(value)?.[1];
  return code && isRoomCodeShape(code) ? code : null;
}

export function roomHash(code: string): string {
  return `#/room/${code}`;
}

/** The shareable link, built from the page's own origin and base path. */
export function roomLink(code: string, origin: string, basePath: string): string {
  return `${origin}${basePath}${roomHash(code)}`;
}
