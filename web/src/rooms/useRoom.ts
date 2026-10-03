import { useEffect, useRef, useState } from "react";
import { WORKER_URL, toWebSocketUrl } from "../config";
import { browserSocketFactory } from "../connection/socket";
import { STORAGE_KEYS, writeKey } from "../storage";
import { browserFetch, checkRoom } from "./api";
import { INITIAL_VIEW, RoomSession, type RoomView } from "./session";

/** One room visit for the room screen. A new socket per join attempt; closed on unmount. */
export function useRoom(code: string) {
  const [view, setView] = useState<RoomView>(INITIAL_VIEW);
  const session = useRef<RoomSession | null>(null);

  useEffect(() => () => session.current?.close(), []);

  // Remember the name that worked, to prefill next time. Names aren't sensitive.
  const joinedName = view.status === "joined" ? view.you?.name : undefined;
  useEffect(() => {
    if (joinedName) writeKey(STORAGE_KEYS.name, joinedName);
  }, [joinedName]);

  const start = (name: string) => {
    session.current?.close();
    const next = new RoomSession({
      url: toWebSocketUrl(WORKER_URL, code),
      createSocket: browserSocketFactory,
      checkCode: () => checkRoom(WORKER_URL, code, browserFetch),
      onChange: setView,
    });
    session.current = next;
    next.join(name);
  };

  return {
    view,
    /** Joins on the open socket after a refused name; otherwise opens a new one. */
    join: (name: string) => (session.current && view.status === "idle" ? session.current.join(name) : start(name)),
    rejoin: (name: string) => start(name),
    say: (text: string) => session.current?.say(text) ?? false,
    leave: () => session.current?.close(),
  };
}
