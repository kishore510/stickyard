import { parentSheet, parseHash, sheetHash, type Sheet } from "../router";

/*
 * Moving between sheets. Every sheet opened in the app gets its own history entry, and
 * that entry's state remembers how many sheets deep it is and whether it was opened
 * from another sheet. So:
 *   - the back arrow (and the browser's Back) returns to the previous sheet;
 *   - close (X, Esc, tap outside) steps back past every sheet to the page underneath;
 *   - a deep link (e.g. #/help/names opened from outside) closes to `#/`.
 */

interface NavState {
  syDepth: number;
  syFromSheet: boolean;
}

function navState(): NavState {
  const s: unknown = window.history.state;
  if (typeof s === "object" && s !== null && "syDepth" in s && typeof s.syDepth === "number") {
    return { syDepth: s.syDepth, syFromSheet: "syFromSheet" in s && s.syFromSheet === true };
  }
  return { syDepth: 0, syFromSheet: false };
}

const currentSheet = (): Sheet | null => {
  const route = parseHash(window.location.hash);
  return route.name === "home" ? route.sheet : null;
};

/** Opens `sheet` on a new history entry. */
export function openSheet(sheet: Sheet): void {
  const fromSheet = currentSheet() !== null;
  const depth = fromSheet ? navState().syDepth : 0;
  window.location.hash = sheetHash(sheet);
  window.history.replaceState({ syDepth: depth + 1, syFromSheet: fromSheet } satisfies NavState, "");
}

/** Whether the open sheet shows a back arrow. */
export function canGoBack(sheet: Sheet): boolean {
  return navState().syFromSheet || parentSheet(sheet) !== null;
}

/** Back arrow: to the sheet this one was opened from, else to its parent, else close. */
export function goBack(): void {
  const { syDepth, syFromSheet } = navState();
  if (syFromSheet) return window.history.back();
  const sheet = currentSheet();
  const parent = sheet && parentSheet(sheet);
  if (!parent) return closeSheets();
  window.location.replace(sheetHash(parent));
  window.history.replaceState({ syDepth, syFromSheet: false } satisfies NavState, "");
}

/** Closes every open sheet, back to the page underneath. */
export function closeSheets(): void {
  const { syDepth } = navState();
  if (syDepth > 0) return window.history.go(-syDepth);
  window.location.replace(sheetHash(null));
}
