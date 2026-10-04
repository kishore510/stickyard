import { MAX_PARTICIPANTS } from "@stickyard/shared";
import type { ReconnectView } from "./session";

/*
 * What the board's connection status says while disconnected (plain text). It never claims more
 * than the page knows: a relay that can't be reached and one over its daily limit look the same
 * from a browser, so that state says "may be".
 */

export interface ConnectionMessage {
  title: string;
  detail: string;
  /** Rejoin is offered (automatic tries aren't running). */
  rejoin: boolean;
}

export const CONNECTION_TEXT = {
  reconnecting: (attempt: number, max: number): ConnectionMessage => ({
    title: "Connection lost. Reconnecting…",
    detail: `Try ${attempt} of ${max}. The board is read-only until you’re back.`,
    rejoin: false,
  }),
  network: {
    title: "You’re offline.",
    detail: "Stickyard will reconnect when your network is back. The board is read-only meanwhile.",
    rejoin: true,
  },
  offline: {
    title: "Offline: Stickyard couldn’t reconnect.",
    detail: "Check your connection, then Rejoin. The board is read-only meanwhile.",
    rejoin: true,
  },
  full: {
    title: "Couldn’t rejoin: the session is full.",
    detail: `It already has ${MAX_PARTICIPANTS} people. Rejoin when someone leaves.`,
    rejoin: true,
  },
  limit: {
    title: "The relay may be unreachable or over its daily limit.",
    detail: "It resets at 00:00 UTC. Stickyard checks again every minute while this tab is open.",
    rejoin: true,
  },
} as const satisfies Record<string, ConnectionMessage | ((attempt: number, max: number) => ConnectionMessage)>;

/** The message for a reconnect state (none: Offline with Rejoin, the safe default). */
export function connectionMessage(reconnect: ReconnectView | null): ConnectionMessage {
  if (!reconnect) return CONNECTION_TEXT.offline;
  if (reconnect.phase === "reconnecting") return CONNECTION_TEXT.reconnecting(reconnect.attempt, reconnect.max);
  return CONNECTION_TEXT[reconnect.phase];
}
