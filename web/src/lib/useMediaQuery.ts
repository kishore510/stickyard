import { useSyncExternalStore } from "react";

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const media = globalThis.matchMedia?.(query);
      media?.addEventListener("change", onChange);
      return () => media?.removeEventListener("change", onChange);
    },
    () => Boolean(globalThis.matchMedia?.(query).matches),
    () => false,
  );
}
