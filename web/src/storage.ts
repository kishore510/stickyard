/**
 * Every browser storage key goes through this. GitHub Pages serves all *.github.io
 * projects of an account from one origin, so keys must be namespaced. Never store anything sensitive.
 */
const PREFIX = "stickyard:";

export function storageKey(name: string): string {
  return `${PREFIX}${name}`;
}

/** The keys this app uses, in one place. */
export const STORAGE_KEYS = {
  /** "light" | "dark" | "system". Mirrored by the inline script in index.html. */
  theme: storageKey("theme"),
  /** The app version whose What's new was last opened. */
  lastSeenVersion: storageKey("last-seen-version"),
  /** The last name used to join a session, to prefill the name sheet. Not sensitive. */
  name: storageKey("name"),
  /** The board's side panels (md and up): width and whether collapsed. Layout only. */
  palettePanel: storageKey("palette-panel"),
  propertiesPanel: storageKey("properties-panel"),
  /** The floating chat panel's size (md and up), once resized. Layout only. */
  chatPanel: storageKey("chat-panel"),
  /** Live cursors (v0.19.0): "off" hides other people's pointers / stops sharing mine. Preferences only. */
  showCursors: storageKey("show-cursors"),
  shareCursor: storageKey("share-cursor"),
  /**
   * Host tokens (protocol v12), one key per room: `stickyard:host:<room id>`, via hostTokenKey.
   * Kept only on the device that started the session, sent only in claimHost, removed when the
   * relay says the session ended or expired (or refuses the token).
   */
  hostTokenPrefix: storageKey("host:"),
  /**
   * Voter keys (protocol v13), one key per room: `stickyard:voter:<room id>`, via voterKeyKey.
   * 128 random bits made on this device, sent only in claimVoter (the relay keeps only an HMAC
   * of it), removed when the session ends or expires. Clearing browser data makes a new voter.
   */
  voterKeyPrefix: storageKey("voter:"),
} as const;

/** The key holding a room's host token on this device. */
export function hostTokenKey(roomId: string): string {
  return `${STORAGE_KEYS.hostTokenPrefix}${roomId}`;
}
/** The key holding this device's voter key for a room. */
export function voterKeyKey(roomId: string): string {
  return `${STORAGE_KEYS.voterKeyPrefix}${roomId}`;
}
// The create passcode is never stored: it lives only in the form's state until it is sent.

export type KeyValueStore = Pick<Storage, "getItem" | "setItem"> & Partial<Pick<Storage, "removeItem">>;

/** localStorage, or undefined where it's missing or blocked (private modes, sandboxed frames). */
export function appStorage(): KeyValueStore | undefined {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

/** Never throws: storage can be missing, blocked or full. Returns null when unavailable. */
export function readKey(key: string, store: KeyValueStore | undefined = appStorage()): string | null {
  try {
    return store?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** Never throws. Returns false when the value couldn't be stored. */
export function writeKey(key: string, value: string, store: KeyValueStore | undefined = appStorage()): boolean {
  try {
    if (!store) return false;
    store.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

/** Never throws. Returns false when the key couldn't be removed. */
export function removeKey(key: string, store: KeyValueStore | undefined = appStorage()): boolean {
  try {
    if (!store?.removeItem) return false;
    store.removeItem(key);
    return true;
  } catch {
    return false;
  }
}
