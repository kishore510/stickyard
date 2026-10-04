import { base64url, hmacSha256 } from "./crypto";

/*
 * Voter id (protocol v13). The web makes a random key per room (128 bits) and sends it only in
 * claimVoter; the relay derives
 *   voterId = base64url(HMAC-SHA256(ROOM_SIGNING_KEY, "stickyard-voter-v1:" + roomId + ":" + key))
 * and keeps only that (in the socket attachment and the votes table), never the key. The domain
 * string differs from the room code's and the host token's, so none can stand in for another, and
 * the same key gives a different voter in every room. Nothing here is compared: the id is a name,
 * not a secret check. Never log the key or the id.
 */

const DOMAIN = "stickyard-voter-v1:";

/** The voter id for `key` in this room, or null without a signing key or room id (fails closed). */
export async function voterIdFor(roomId: string, key: string, signingKey: string): Promise<string | null> {
  if (!signingKey || !roomId) return null;
  return base64url(await hmacSha256(signingKey, `${DOMAIN}${roomId}:${key}`));
}
