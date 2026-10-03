/**
 * Media queries for layout switches made in script. The widths must match the
 * --breakpoint-* values in tokens.css (a test checks this).
 */
export const BREAKPOINTS = { sm: "40rem", md: "48rem", lg: "64rem", xl: "80rem" } as const;

export const MEDIA = {
  /** Tablet and up: sheets become a side panel. */
  tablet: `(min-width: ${BREAKPOINTS.md})`,
  desktop: `(min-width: ${BREAKPOINTS.lg})`,
  reducedMotion: "(prefers-reduced-motion: reduce)",
  systemDark: "(prefers-color-scheme: dark)",
  /** Mouse or trackpad: safe to put focus in a search box without opening a phone keyboard. */
  finePointer: "(hover: hover) and (pointer: fine)",
} as const;
