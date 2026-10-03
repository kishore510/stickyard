import { create } from "zustand";
import { STORAGE_KEYS, readKey, writeKey, type KeyValueStore } from "../storage";
import { APP_VERSION } from "../version";

/*
 * The "What's new" dot on the menu button: the version whose notes were last opened
 * is remembered in this browser. If storage is missing or blocked, nothing is
 * remembered and the dot simply shows again next time.
 */

export const readLastSeen = (store?: KeyValueStore): string | null => readKey(STORAGE_KEYS.lastSeenVersion, store);

/** True when this version's notes haven't been opened in this browser yet. */
export const hasUnseenChanges = (lastSeen: string | null, current: string): boolean => lastSeen !== current;

interface WhatsNewState {
  unseen: boolean;
  /** Opening What's new counts as seeing this version's changes. */
  markSeen(): void;
}

export const useWhatsNew = create<WhatsNewState>()((set) => ({
  unseen: hasUnseenChanges(readLastSeen(), APP_VERSION),
  markSeen: () => {
    writeKey(STORAGE_KEYS.lastSeenVersion, APP_VERSION);
    set({ unseen: false });
  },
}));
