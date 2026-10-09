import { MAX_FOLLOWERS } from "@stickyard/shared";
import { VIEW_ANIMATION_MS } from "../canvas/navigation";
import { isUserMove, type FollowEnd } from "./follow";

/*
 * Follow and Bring to me, the UI (v0.31.0, part 2 of 2): texts and pure rules. Names come from the
 * room and are untrusted: callers pass them already truncated, and they're only ever rendered as
 * text. The relay's rules (who may follow whom, the cap, the Bring to me budget) are in follow.ts
 * and the relay; these only decide what the page shows and when it may ask.
 */

export const FOLLOW_TEXT = {
  follow: "Follow",
  stopFollowing: "Stop following",
  followLabel: (name: string) => `Follow ${name}`,
  stopLabel: (name: string) => `Stop following ${name}`,
  following: (name: string) => `Following ${name}`,
  waiting: (name: string) => `Waiting for ${name}’s view.`,
  waitingWhy: "Phones and hidden tabs don’t share a view.",
  stop: "Stop",
  started: (name: string) => `Following ${name}. Pan or zoom to stop.`,
  stopped: (name: string) => `Stopped following ${name}.`,
  left: (name: string) => `${name} left.`,
  notFound: "That person isn’t here.",
  self: "You can’t follow yourself.",
  full: (name: string) => `${name} already has ${MAX_FOLLOWERS} people following.`,
  followers: (count: number) => `${count} following you`,
  offline: "Not connected.",
  /** Used when a name isn't known any more. */
  someone: "That person",
} as const;

export const BRING_TEXT = {
  heading: "Bring to me",
  button: "Bring to me",
  about: "Asks everyone else to come to your view. Nobody is moved until they choose Go there.",
  sent: "Asked everyone to come to your view.",
  cooldown: "Wait a few seconds.",
  offline: "Not connected.",
  banner: (name: string) => `${name} asked everyone to come to their view`,
  bannerFollowing: (name: string) => `Go there stops following ${name}.`,
  goThere: "Go there",
  dismiss: "Dismiss",
  /** Used when the host's name isn't known any more. */
  someone: "The host",
} as const;

/** After a Bring to me the button is off this long (the relay allows 1 every 5 seconds). */
export const BRING_COOLDOWN_MS = 5000;
/** A Bring to me banner goes by itself after this long: the host's view has moved on by then, and they can send again. */
export const BROUGHT_BANNER_MS = 60_000;
/** How long a plain follow notice ("Stopped following Sam.") stays. */
export const FOLLOW_NOTICE_MS = 5000;
/** Leader updates closer together than this are a stream: set directly, never a queue of animations. */
export const FOLLOW_STREAM_MS = 600;

/** The notice when my follow ended (the relay's reason, or my followStart was refused). */
export function followEndText(reason: FollowEnd, name: string | null): string {
  const who = name ?? FOLLOW_TEXT.someone;
  switch (reason) {
    case "target_left":
      return FOLLOW_TEXT.left(who);
    case "not_found":
      return FOLLOW_TEXT.notFound;
    case "self":
      return FOLLOW_TEXT.self;
    case "followers_full":
      return FOLLOW_TEXT.full(who);
  }
}

/** Why Follow is off (null: on). Myself never gets a Follow button at all, as with Go to. */
export function followReason({ live }: { live: boolean }): string | null {
  return live ? null : FOLLOW_TEXT.offline;
}

/** Why Bring to me is off (null: on): not connected, or within BRING_COOLDOWN_MS of the last one. */
export function bringReason({ live, now, sentAt }: { live: boolean; now: number; sentAt: number | null }): string | null {
  if (!live) return BRING_TEXT.offline;
  if (sentAt !== null && now - sentAt < BRING_COOLDOWN_MS) return BRING_TEXT.cooldown;
  return null;
}

/** How long a move to the leader's view animates: none with reduced motion or within a stream of updates. */
export function followDuration({ now, last, reduced }: { now: number; last: number | null; reduced: boolean }): number {
  if (reduced) return 0;
  return last !== null && now - last < FOLLOW_STREAM_MS ? 0 : VIEW_ANIMATION_MS;
}

/**
 * Tells my own pans and zooms from the page's. Moves the page makes for following (and Go there)
 * run inside `programmatic`; while one runs, a move event never counts as mine, even one carrying
 * an input event. Outside, a move is mine when React Flow passed the input event (follow.ts isUserMove).
 */
export class MoveGuard {
  private depth = 0;

  programmatic<T>(move: () => T): T {
    this.depth += 1;
    try {
      return move();
    } finally {
      this.depth -= 1;
    }
  }

  get active(): boolean {
    return this.depth > 0;
  }

  userMove(event: Event | MouseEvent | TouchEvent | null | undefined): boolean {
    return this.depth === 0 && isUserMove(event);
  }
}
