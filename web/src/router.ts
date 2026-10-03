import { useSyncExternalStore } from "react";

/** Known hash routes. Slice 0 has only the connection check at `#/`. */
export type Route = { name: "home" } | { name: "not-found" };

export function parseHash(hash: string): Route {
  const path = hash.replace(/^#/, "") || "/";
  return path === "/" ? { name: "home" } : { name: "not-found" };
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

export function useHashRoute(): Route {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash);
  return parseHash(hash);
}
