import { create } from "zustand";
import type { BroughtView, FollowEnd, FollowSink, LeaderView } from "./follow";

/*
 * Follow and Bring to me (protocol v19), apart from the room view so a followed person's panning
 * re-renders only what reads it. In memory only: never persisted, and a reconnect starts empty.
 */
interface FollowState {
  /** The participant I follow, or null. */
  following: string | null;
  /** How many people follow me (a count from the relay, never who). */
  followers: number;
  /** The last view of the person I follow. */
  leader: LeaderView | null;
  /** Why my last follow ended, until I follow again. */
  ended: FollowEnd | null;
  /** The last Bring to me, with a sequence number so a repeat of the same view is still new. */
  brought: (BroughtView & { seq: number }) | null;
}

const EMPTY: FollowState = { following: null, followers: 0, leader: null, ended: null, brought: null };

export const useFollow = create<FollowState>()(() => ({ ...EMPTY }));

let seq = 0;

/** The store as the session's sink. */
export const followSink: FollowSink = {
  following: (id) => useFollow.setState(id === null ? { following: null, leader: null } : { following: id, leader: null, ended: null }),
  followers: (count) => useFollow.setState({ followers: count }),
  viewport: (view) => useFollow.setState({ leader: view }),
  ended: (reason) => useFollow.setState({ following: null, leader: null, ended: reason }),
  brought: (view) => useFollow.setState({ brought: { ...view, seq: ++seq } }),
  clear: () => useFollow.setState({ ...EMPTY }),
};
