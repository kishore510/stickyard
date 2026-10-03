import { useSyncExternalStore } from "react";

/*
 * Hash routes. The home page is `#/`. Sheets open over it and have their own addresses,
 * so links and the browser's Back button work:
 *
 *   #/help            Help (search, quick start, topics)
 *   #/help/<topic>    one help topic, e.g. #/help/names
 *   #/changelog       What's new
 *   #/about           About
 *
 * A session is `#/room/<code>`. Sheets opened from a room show over it (see App.tsx).
 */

export type Sheet = { kind: "help" } | { kind: "help-topic"; id: string } | { kind: "changelog" } | { kind: "about" };

export type Route = { name: "home"; sheet: Sheet | null } | { name: "room"; code: string } | { name: "not-found" };

const TOPIC = /^\/help\/([a-z0-9-]{1,64})$/;
/** Any single path segment, so a malformed code still reaches the room screen ("This link isn't valid"). */
const ROOM = /^\/room\/([^/]{1,200})$/;

export function parseHash(hash: string): Route {
  const path = hash.replace(/^#/, "") || "/";
  switch (path) {
    case "/":
      return { name: "home", sheet: null };
    case "/help":
      return { name: "home", sheet: { kind: "help" } };
    case "/changelog":
      return { name: "home", sheet: { kind: "changelog" } };
    case "/about":
      return { name: "home", sheet: { kind: "about" } };
  }
  const code = ROOM.exec(path)?.[1];
  if (code) return { name: "room", code };
  const topic = TOPIC.exec(path)?.[1];
  return topic ? { name: "home", sheet: { kind: "help-topic", id: topic } } : { name: "not-found" };
}

export function sheetHash(sheet: Sheet | null): string {
  if (!sheet) return "#/";
  switch (sheet.kind) {
    case "help":
      return "#/help";
    case "help-topic":
      return `#/help/${sheet.id}`;
    case "changelog":
      return "#/changelog";
    case "about":
      return "#/about";
  }
}

/** The sheet a sheet's back arrow leads to when it wasn't opened from another sheet (a deep link). */
export function parentSheet(sheet: Sheet): Sheet | null {
  return sheet.kind === "help-topic" ? { kind: "help" } : null;
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener("hashchange", onChange);
  window.addEventListener("popstate", onChange);
  return () => {
    window.removeEventListener("hashchange", onChange);
    window.removeEventListener("popstate", onChange);
  };
}

export function useHashRoute(): Route {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash);
  return parseHash(hash);
}
