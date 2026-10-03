import { useState } from "react";
import { useHashRoute, type Route } from "./router";
import { HomeScreen } from "./screens/HomeScreen";
import { RoomScreen } from "./screens/RoomScreen";
import { SheetHost } from "./shell/SheetHost";
import { Shell } from "./shell/Shell";

/** The page under any open sheet: home, or the room the sheet was opened from. */
type Base = { name: "home" } | { name: "room"; code: string };

/**
 * Sheets (Help, What's new, About) have their own hash, e.g. `#/help`. Opened from a room,
 * they show over that room, which stays connected; closing them returns to its `#/room/...`.
 */
function useBase(route: Route): Base {
  const [base, setBase] = useState<Base>(route.name === "room" ? route : { name: "home" });
  const next: Base | null =
    route.name === "room" ? route : route.name === "home" && route.sheet === null ? { name: "home" } : null;
  const changed = next !== null && (next.name !== base.name || (next.name === "room" && base.name === "room" && next.code !== base.code));
  if (changed) setBase(next);
  return changed ? next : base;
}

export function App() {
  const route = useHashRoute();
  const base = useBase(route);

  if (route.name === "not-found") {
    return (
      <Shell>
        <div className="mx-auto flex w-full max-w-content flex-1 flex-col justify-center gap-md py-lg">
          <h1 className="text-2xl font-semibold">Page not found</h1>
          <p>
            <a href="#/" className="inline-flex min-h-touch items-center font-medium text-accent underline">
              Go to the start page
            </a>
          </p>
        </div>
      </Shell>
    );
  }

  return (
    <Shell bleed={base.name === "room"}>
      {base.name === "room" ? <RoomScreen key={base.code} code={base.code} /> : <HomeScreen />}
      {route.name === "home" && route.sheet && <SheetHost sheet={route.sheet} />}
    </Shell>
  );
}
