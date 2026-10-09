import { clampViewportView, type FollowEndReason } from "@stickyard/shared";
import { viewportCentre, type Size, type Viewport } from "../canvas/geometry";

/*
 * Follow and Bring to me (protocol v19): the pure rules. A view on the wire is the board point at
 * the centre of someone's canvas and their zoom, so it means the same on any screen size. Sending
 * (when, how often) and the sink the session reports to. No timers or I/O here except in
 * ViewportSender, whose clock and timers are injected.
 */

/** At most one viewport message this often (5 a second). */
export const FOLLOW_SEND_INTERVAL_MS = 200;
/** A view must have moved this far (board units, either axis) since the last send... */
export const VIEW_MIN_MOVE = 1;
/** ...or zoomed by this much. */
export const VIEW_MIN_ZOOM_CHANGE = 0.001;

export interface View {
  x: number;
  y: number;
  zoom: number;
}

/** Someone's view as the relay forwards it: theirs (`id`) and where. */
export interface LeaderView extends View {
  id: string;
}

/** A host brought everyone to their view. */
export interface BroughtView extends View {
  from: string;
}

/** Why following ended: the relay's reasons, or my followStart was refused (that person has MAX_FOLLOWERS). */
export type FollowEnd = FollowEndReason | "followers_full";

/** The view a React Flow viewport shows on a canvas of `size`: its centre, whole units, zoom to 3 decimals. */
export function viewFromCentre(v: Viewport, size: Size): View {
  const centre = viewportCentre(v, size);
  return clampViewportView(centre.x, centre.y, v.zoom);
}

/** Changed enough to send: anything the first time; then a move of VIEW_MIN_MOVE or a zoom change of VIEW_MIN_ZOOM_CHANGE. */
export function viewChanged(last: View | null, next: View): boolean {
  if (!last) return true;
  return Math.abs(next.x - last.x) >= VIEW_MIN_MOVE || Math.abs(next.y - last.y) >= VIEW_MIN_MOVE || Math.abs(next.zoom - last.zoom) >= VIEW_MIN_ZOOM_CHANGE - 1e-9;
}

/** A page sends its view only while joined, followed by at least one person, and never from a phone. */
export function mayShareViewport({ live, followers, compact }: { live: boolean; followers: number; compact: boolean }): boolean {
  return live && followers > 0 && !compact;
}

/**
 * A pan or zoom the person made themselves (React Flow's onMoveStart passes the input event; a
 * programmatic move, such as fit, a jump or following someone, passes none). Only these stop following.
 */
export function isUserMove(event: Event | MouseEvent | TouchEvent | null | undefined): boolean {
  return event !== null && event !== undefined;
}

export interface ViewportSenderDeps {
  now(): number;
  setTimer(fn: () => void, ms: number): number | ReturnType<typeof setTimeout>;
  clearTimer(id: number | ReturnType<typeof setTimeout> | undefined): void;
  /** Sends a view; false when the session wouldn't (not followed, a phone, not connected). */
  send(view: View): boolean;
}

/**
 * Throttles my view to FOLLOW_SEND_INTERVAL_MS: a leading send, then at most one trailing send per
 * interval with the latest view, and only when it changed. `force` sends even an unchanged view (a
 * new follower needs it), still within the interval. A refused send doesn't count.
 */
export class ViewportSender {
  private last: { at: number; view: View } | null = null;
  private pending: View | null = null;
  private timer: number | ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly deps: ViewportSenderDeps) {}

  offer(view: View): void {
    this.consider(view, false);
  }

  force(view: View): void {
    this.consider(view, true);
  }

  /** Forgets the last view and any waiting one, telling nobody (a drop, a new visit, no followers). */
  reset(): void {
    this.deps.clearTimer(this.timer);
    this.timer = undefined;
    this.pending = null;
    this.last = null;
  }

  private forced = false;

  private consider(view: View, force: boolean): void {
    const last = this.last;
    if (!force && !this.forced && last && !viewChanged(last.view, view)) {
      this.pending = null;
      return;
    }
    const since = last ? this.deps.now() - last.at : Number.POSITIVE_INFINITY;
    if (since < FOLLOW_SEND_INTERVAL_MS) {
      this.pending = view;
      this.forced ||= force;
      if (this.timer === undefined) this.timer = this.deps.setTimer(() => this.flush(), FOLLOW_SEND_INTERVAL_MS - since);
      return;
    }
    this.sendNow(view);
  }

  private flush(): void {
    this.timer = undefined;
    const view = this.pending;
    const force = this.forced;
    this.pending = null;
    this.forced = false;
    if (view) this.consider(view, force);
  }

  private sendNow(view: View): void {
    this.deps.clearTimer(this.timer);
    this.timer = undefined;
    this.pending = null;
    this.forced = false;
    if (this.deps.send(view)) this.last = { at: this.deps.now(), view };
  }
}

/** Where the session reports following (followStore.ts). Never part of the room view, never stored. */
export interface FollowSink {
  /** Who I follow now (null: nobody). */
  following(id: string | null): void;
  /** How many people follow me. */
  followers(count: number): void;
  /** The view of the person I follow. */
  viewport(view: LeaderView): void;
  /** My follow ended (following becomes null). */
  ended(reason: FollowEnd): void;
  /** A host brought everyone to their view. */
  brought(view: BroughtView): void;
  /** A new visit, a reconnect, a drop or leaving: everything goes. */
  clear(): void;
}
