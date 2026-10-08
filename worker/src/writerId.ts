import { base64url, hmacSha256 } from "./crypto";

/*
 * Writer id (silent brainstorm, protocol v17). The page sends its client key for the room (the
 * same random key it uses as a voter) in `join`; the relay derives
 *   writerId = base64url(HMAC-SHA256(ROOM_SIGNING_KEY, "stickyard-writer-v1:" + roomId + ":" + key))
 * and keeps only that: in the socket attachment, and on sealed notes until the reveal. Its domain
 * differs from the voter id's ("stickyard-voter-v1:"), the room code's and the host token's, so a
 * stored writer id and a stored voter id from the same key can't be matched up, and the same key
 * gives a different writer in every room. It is a name, never sent to any page. Never log the key
 * or the id.
 */

const DOMAIN = "stickyard-writer-v1:";

/** The writer id for `key` in this room, or null without a signing key or room id (fails closed). */
export async function writerIdFor(roomId: string, key: string, signingKey: string): Promise<string | null> {
  if (!signingKey || !roomId) return null;
  return base64url(await hmacSha256(signingKey, `${DOMAIN}${roomId}:${key}`));
}
