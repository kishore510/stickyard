import { STORAGE_KEYS, appStorage, readKey, removeKey, writeKey, type KeyValueStore } from "../storage";
import { rememberSecret } from "./redact";

/*
 * Where the person's Anthropic API key lives (v0.42.0). Two places, never both:
 *   - "session" (the default, "This session only"): this module-private variable. Nothing goes in
 *     browser storage; a reload or closing the tab forgets it.
 *   - "device" ("Remember on this device", after the warning page): localStorage under the one
 *     registered key STORAGE_KEYS.aiKey, unencrypted.
 * The rest of the app sees only { place, tail } (KeyStatus). The key itself is read with readApiKey
 * at the moment of a send and passed straight to the client; nothing keeps it in state or the UI.
 */

let sessionKey: string | null = null;

export type KeyPlace = "none" | "session" | "device";
export type KeepChoice = "session" | "device";

export interface KeyStatus {
  place: KeyPlace;
  /** The key's last four characters, for "•••• abcd"; "" with no key. */
  tail: string;
}

const NO_KEY: KeyStatus = { place: "none", tail: "" };

/** Strips every whitespace character (a pasted key often brings a line break or spaces). */
export function cleanKey(raw: string): string {
  return raw.replace(/\s+/g, "");
}

/** A soft check for a hint only: Anthropic API keys start with sk-ant-. Never blocks saving. */
export function looksLikeAnthropicKey(key: string): boolean {
  return key.startsWith("sk-ant-");
}

export function keyTail(key: string): string {
  return key.slice(-4);
}

function storedKey(store: KeyValueStore | undefined): string | null {
  const value = readKey(STORAGE_KEYS.aiKey, store);
  return value ? value : null;
}

/** Where the key is now, without handing it out. */
export function keyStatus(store: KeyValueStore | undefined = appStorage()): KeyStatus {
  if (sessionKey) return { place: "session", tail: keyTail(sessionKey) };
  const stored = storedKey(store);
  if (!stored) return NO_KEY;
  rememberSecret(stored);
  return { place: "device", tail: keyTail(stored) };
}

/** The key, for a send only: call it at the moment of sending and pass it straight to the client. */
export function readApiKey(store: KeyValueStore | undefined = appStorage()): string | null {
  const key = sessionKey ?? storedKey(store);
  if (key) rememberSecret(key);
  return key;
}

function place(key: string, keep: KeepChoice, store: KeyValueStore | undefined): { status: KeyStatus; fellBack: boolean } {
  rememberSecret(key);
  if (keep === "device" && writeKey(STORAGE_KEYS.aiKey, key, store)) {
    sessionKey = null;
    return { status: { place: "device", tail: keyTail(key) }, fellBack: false };
  }
  sessionKey = key;
  removeKey(STORAGE_KEYS.aiKey, store);
  return { status: { place: "session", tail: keyTail(key) }, fellBack: keep === "device" };
}

export type SaveKeyResult = { ok: true; status: KeyStatus; fellBack: boolean } | { ok: false; reason: "empty" };

/** Saves a new key where the person chose; blocked storage falls back to this session only (`fellBack`). */
export function saveApiKey(raw: string, keep: KeepChoice, store: KeyValueStore | undefined = appStorage()): SaveKeyResult {
  const key = cleanKey(raw);
  if (!key) return { ok: false, reason: "empty" };
  return { ok: true, ...place(key, keep, store) };
}

/** Moves the saved key to the other place (the Keep the key choice changed). */
export function moveApiKey(keep: KeepChoice, store: KeyValueStore | undefined = appStorage()): { status: KeyStatus; fellBack: boolean } {
  const key = readApiKey(store);
  if (!key) return { status: NO_KEY, fellBack: false };
  return place(key, keep, store);
}

/** Forgets the key in both places. */
export function removeApiKey(store: KeyValueStore | undefined = appStorage()): KeyStatus {
  sessionKey = null;
  removeKey(STORAGE_KEYS.aiKey, store);
  return NO_KEY;
}
