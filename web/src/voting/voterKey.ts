import { VOTER_KEY_MAX_LENGTH, VOTER_KEY_MIN_LENGTH } from "@stickyard/shared";
import { appStorage, readKey, removeKey, voterKeyKey, writeKey, type KeyValueStore } from "../storage";

/*
 * This device's voter key for a room (dot voting, protocol v13): 128 random bits, base64url. It
 * makes this browser one anonymous voter in that room (a reload, a second tab or a reconnect
 * votes as the same voter). Sent only in claimVoter; the relay keeps only an HMAC of it. Never
 * shown, never in a URL, never copied by Copy link or Copy details.
 */

export const VOTER_KEY_BYTES = 16;

const keyPattern = new RegExp(`^[A-Za-z0-9_-]{${VOTER_KEY_MIN_LENGTH},${VOTER_KEY_MAX_LENGTH}}$`);

/** A fresh key: VOTER_KEY_BYTES from crypto.getRandomValues, base64url without padding (22 characters). */
export function newVoterKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(VOTER_KEY_BYTES));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/**
 * The room's key on this device, made and stored the first time. Never throws: with storage
 * missing, blocked or full a fresh key is returned (this visit still votes; a reload is then a
 * new voter).
 */
export function voterKeyFor(roomId: string, store: KeyValueStore | undefined = appStorage()): string {
  const stored = readKey(voterKeyKey(roomId), store);
  if (stored !== null && keyPattern.test(stored)) return stored;
  const key = newVoterKey();
  writeKey(voterKeyKey(roomId), key, store);
  return key;
}

/** Forgets the room's key (the session ended or expired). Never throws. */
export function forgetVoterKey(roomId: string, store: KeyValueStore | undefined = appStorage()): void {
  removeKey(voterKeyKey(roomId), store);
}
