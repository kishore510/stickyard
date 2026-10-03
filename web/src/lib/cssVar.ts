/** A token's value in px (e.g. "80px" -> 80), or `fallback` where it can't be read (tests, old browsers). */
export function readPxToken(name: `--sy-${string}`, fallback: number): number {
  try {
    const value = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));
    return Number.isFinite(value) ? value : fallback;
  } catch {
    return fallback;
  }
}
