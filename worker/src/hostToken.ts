import { base64url, hmacSha256, safeEqual } from "./crypto";

/*
 * Host token (protocol v12). Stateless: it is derived, never stored on the relay.
 *   hostToken = base64url(HMAC-SHA256(ROOM_SIGNING_KEY, "stickyard-host-v1:" + roomId)), all 32 bytes.
 * The domain string differs from the room code's ("stickyard-room-v1:"), so neither can stand in
 * for the other. POST /rooms returns it once, next to the code; it is only ever sent back in
 * claimHost. Never put it in a URL or a log.
 */

const DOMAIN = "stickyard-host-v1:";

export async function hostTokenFor(roomId: string, signingKey: string): Promise<string> {
  return base64url(await hmacSha256(signingKey, `${DOMAIN}${roomId}`));
}

/** Constant time (safeEqual). A missing key never verifies. */
export async function verifyHostToken(candidate: string, roomId: string, signingKey: string): Promise<boolean> {
  if (!signingKey || !roomId) return false;
  return safeEqual(candidate, await hostTokenFor(roomId, signingKey));
}
