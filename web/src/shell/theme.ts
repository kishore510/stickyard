import { create } from "zustand";
import { MEDIA } from "../styles/breakpoints";
import { STORAGE_KEYS, readKey, writeKey, type KeyValueStore } from "../storage";

export const THEME_PREFERENCES = ["system", "light", "dark"] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];
export type Theme = "light" | "dark";

export function parsePreference(value: unknown): ThemePreference {
  return THEME_PREFERENCES.includes(value as ThemePreference) ? (value as ThemePreference) : "system";
}

export function resolveTheme(preference: ThemePreference, systemPrefersDark: boolean): Theme {
  if (preference === "system") return systemPrefersDark ? "dark" : "light";
  return preference;
}

/** Cycle order for the single toggle button: system -> light -> dark -> system. */
export function nextPreference(preference: ThemePreference): ThemePreference {
  const index = THEME_PREFERENCES.indexOf(preference);
  return THEME_PREFERENCES[(index + 1) % THEME_PREFERENCES.length] ?? "system";
}

/** The stored preference. Mirrored by the inline script in index.html (a test keeps them in step). */
export const readPreference = (store?: KeyValueStore): ThemePreference =>
  parsePreference(readKey(STORAGE_KEYS.theme, store));

const systemDark = () => Boolean(globalThis.matchMedia?.(MEDIA.systemDark).matches);

/** Applies the resolved theme to <html data-theme>. */
export function applyTheme(preference: ThemePreference): void {
  document.documentElement.dataset.theme = resolveTheme(preference, systemDark());
}

interface ThemeState {
  preference: ThemePreference;
  set(preference: ThemePreference): void;
  cycle(): void;
}

export const useThemeStore = create<ThemeState>()((set, get) => ({
  preference: readPreference(),
  set: (preference) => {
    writeKey(STORAGE_KEYS.theme, preference);
    applyTheme(preference);
    set({ preference });
  },
  cycle: () => get().set(nextPreference(get().preference)),
}));

/** Applies the stored theme now and follows the OS setting while the preference is "system". */
export function startTheme(): () => void {
  applyTheme(useThemeStore.getState().preference);
  const media = globalThis.matchMedia?.(MEDIA.systemDark);
  const onChange = () => applyTheme(useThemeStore.getState().preference);
  media?.addEventListener("change", onChange);
  return () => media?.removeEventListener("change", onChange);
}
