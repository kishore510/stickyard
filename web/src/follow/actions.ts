import { truncateName } from "../presence/avatars";
import type { View } from "./follow";
import { bringSent, followStarted, followStopped, useFollow } from "./followStore";
import { bringReason } from "./followUi";

/*
 * What the Follow, Stop and Bring to me controls do (v0.31.0), shared by Participants, the chip,
 * the canvas, the board bar and the phone Session section. The session decides whether anything is
 * sent; these only say so, once, when it was.
 */

let viewSource: (() => View | null) | null = null;

/**
 * The board registers where my view comes from (useCanvasView `view`), so controls outside the
 * canvas (the Participants sheet's Session section) can bring everyone to it. Null to forget.
 */
export function setViewSource(source: (() => View | null) | null): void {
  viewSource = source;
}

/** My view now, or null before the board has a size. */
export function currentView(): View | null {
  return viewSource?.() ?? null;
}

/** Follows this person (the session refuses myself, someone not here, or while not connected). */
export function followPerson(start: (id: string) => boolean, id: string, name: string): boolean {
  if (!start(id)) return false;
  followStarted(truncateName(name));
  return true;
}

/** Stops following (Stop, my own pan or zoom, Go there); says so only when something stopped. */
export function stopFollowing(stop: () => boolean): boolean {
  if (!stop()) return false;
  followStopped();
  return true;
}

/**
 * Brings everyone to my view, never inside the cooldown (the relay allows 1 every 5 seconds) and
 * never without a view. True when it was sent.
 */
export function sendBring({ live, bringToMe }: { live: boolean; bringToMe(view: View): boolean }, now: number = Date.now()): boolean {
  if (bringReason({ live, now, sentAt: useFollow.getState().bringSentAt }) !== null) return false;
  const view = currentView();
  if (!view || !bringToMe(view)) return false;
  bringSent(now);
  return true;
}
