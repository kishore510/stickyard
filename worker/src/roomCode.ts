import { isRoomCodeShape } from "@stickyard/shared";
import { base64url, hmacSha256, randomBase64url, safeEqual } from "./crypto";

/*
 * Room code = `<id>.<sig>`.
 *   id  = 16 random bytes, base64url (22 chars). The room's Durable Object is addressed by it.
 *   sig = HMAC-SHA256(ROOM_SIGNING_KEY, "stickyard-room-v1:" + id), first 16 bytes, base64url.
 * Only the Worker can mint codes, so invented codes never reach a Durable Object.
 */

const DOMAIN = "stickyard-room-v1:";
const ID_BYTES = 16;
const SIG_BYTES = 16;

async function sign(id: string, signingKey: string): Promise<string> {
  return base64url((await hmacSha256(signingKey, `${DOMAIN}${id}`)).slice(0, SIG_BYTES));
}

export async function createRoomCode(signingKey: string): Promise<string> {
  const id = randomBase64url(ID_BYTES);
  return `${id}.${await sign(id, signingKey)}`;
}

/**
 * Returns the room id for a validly signed code, else null. The signature is compared as
 * its canonical string (not decoded bytes), so a non-canonical spelling of the same bytes
 * is rejected too.
 */
export async function verifyRoomCode(code: string | null, signingKey: string): Promise<string | null> {
  if (code === null || !isRoomCodeShape(code)) return null;
  const [id = "", sig = ""] = code.split(".");
  return (await safeEqual(sig, await sign(id, signingKey))) ? id : null;
}
