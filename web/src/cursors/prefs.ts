import { create } from "zustand";
import { STORAGE_KEYS, readKey, writeKey, type KeyValueStore } from "../storage";

/*
 * The two cursor switches in Participants: show other people's cursors, share mine. Both on by
 * default; stored in this browser ("off" / "on") only once changed. Preferences only.
 */
export interface CursorPrefs {
  show: boolean;
  share: boolean;
}

const KEYS = { show: STORAGE_KEYS.showCursors, share: STORAGE_KEYS.shareCursor } as const;

export function readCursorPrefs(store?: KeyValueStore): CursorPrefs {
  return { show: readKey(KEYS.show, store) !== "off", share: readKey(KEYS.share, store) !== "off" };
}

export function writeCursorPref(pref: keyof CursorPrefs, on: boolean, store?: KeyValueStore): boolean {
  return writeKey(KEYS[pref], on ? "on" : "off", store);
}

interface PrefsState extends CursorPrefs {
  set(pref: keyof CursorPrefs, on: boolean): void;
}

export const useCursorPrefs = create<PrefsState>()((set) => ({
  ...readCursorPrefs(),
  set: (pref, on) => {
    writeCursorPref(pref, on);
    set({ [pref]: on });
  },
}));
