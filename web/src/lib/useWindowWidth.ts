import { useSyncExternalStore } from "react";

/** The window's width in CSS px, updated on resize (panels re-clamp their widths to it). */
export function useWindowWidth(): number {
  return useSyncExternalStore(
    (onChange) => {
      globalThis.addEventListener?.("resize", onChange);
      return () => globalThis.removeEventListener?.("resize", onChange);
    },
    () => globalThis.innerWidth ?? 0,
    () => 0,
  );
}
