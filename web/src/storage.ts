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
} as const;

export type KeyValueStore = Pick<Storage, "getItem" | "setItem">;

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
