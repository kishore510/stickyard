import { create } from "zustand";
import { STORAGE_KEYS, readKey, writeKey } from "../storage";
import { keyStatus, moveApiKey, removeApiKey, saveApiKey, type KeepChoice, type KeyPlace } from "./keyStore";

/*
 * AI state for the page (v0.42.0): where the key is ({ place, tail }, never the key), the Keep the
 * key choice and whether the first-time notice was seen (preferences, their own storage key), and
 * the last Test key result in memory. `keyVersion` goes up on every key change, so a test that was
 * running for the old key throws its result away.
 */

export interface Prefs {
  keep: KeepChoice;
  noticeSeen: boolean;
}

const DEFAULT_PREFS: Prefs = { keep: "session", noticeSeen: false };

/** Preferences are read back as untrusted data: anything unexpected is the default. */
export function parsePrefs(raw: string | null): Prefs {
  if (!raw) return DEFAULT_PREFS;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return DEFAULT_PREFS;
    const keep = "keep" in value && value.keep === "device" ? "device" : "session";
    const noticeSeen = "noticeSeen" in value && value.noticeSeen === true;
    return { keep, noticeSeen };
  } catch {
    return DEFAULT_PREFS;
  }
}

const writePrefs = (prefs: Prefs) => writeKey(STORAGE_KEYS.aiPrefs, JSON.stringify(prefs));

export interface LastTest {
  ok: boolean;
  /** When it finished (ms since the epoch). */
  at: number;
}

interface AiState extends Prefs {
  place: KeyPlace;
  tail: string;
  keyVersion: number;
  lastTest: LastTest | null;
  /** Saves a new key in the chosen place. `fellBack`: storage blocked, kept for this session only. */
  save: (raw: string) => { ok: boolean; fellBack: boolean };
  remove: () => void;
  /** The Keep the key choice; moves a saved key. `fellBack`: storage blocked, so this session only. */
  setKeep: (keep: KeepChoice) => { fellBack: boolean };
  setLastTest: (test: LastTest) => void;
  markNoticeSeen: () => void;
}

const initialPrefs = parsePrefs(readKey(STORAGE_KEYS.aiPrefs));
const initialStatus = keyStatus();

export const useAi = create<AiState>((set, get) => ({
  ...initialPrefs,
  // A remembered key decides the choice shown, whatever the preference says.
  keep: initialStatus.place === "device" ? "device" : initialPrefs.keep,
  place: initialStatus.place,
  tail: initialStatus.tail,
  keyVersion: 0,
  lastTest: null,
  save: (raw) => {
    const result = saveApiKey(raw, get().keep);
    if (!result.ok) return { ok: false, fellBack: false };
    set((s) => ({ ...result.status, keyVersion: s.keyVersion + 1, lastTest: null, keep: result.fellBack ? "session" : s.keep }));
    return { ok: true, fellBack: result.fellBack };
  },
  remove: () => {
    const status = removeApiKey();
    set((s) => ({ ...status, keyVersion: s.keyVersion + 1, lastTest: null }));
  },
  setKeep: (keep) => {
    const { place, tail, noticeSeen } = get();
    const moved = place === "none" ? { status: { place, tail }, fellBack: false } : moveApiKey(keep);
    const stored = writePrefs({ keep, noticeSeen });
    const fellBack = moved.fellBack || (keep === "device" && !stored);
    const chosen: KeepChoice = fellBack ? "session" : keep;
    if (chosen !== keep) writePrefs({ keep: chosen, noticeSeen });
    set({ keep: chosen, place: moved.status.place, tail: moved.status.tail });
    return { fellBack };
  },
  setLastTest: (lastTest) => set({ lastTest }),
  markNoticeSeen: () => {
    writePrefs({ keep: get().keep, noticeSeen: true });
    set({ noticeSeen: true });
  },
}));
