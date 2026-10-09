import { create } from "zustand";
import type { BroughtView, FollowEnd, FollowSink, LeaderView } from "./follow";
import { BRING_TEXT, FOLLOW_TEXT, followEndText } from "./followUi";

/*
 * Follow and Bring to me (protocol v19), apart from the room view so a followed person's panning
 * re-renders only what reads it. In memory only: never persisted, and a reconnect starts empty.
 * Since v0.31.0 it also keeps what the UI says about it: the followed person's name, one plain
 * notice, the polite announcer's text, the dismissed banner and when I last brought everyone.
 */
interface Line {
  text: string;
  /** Counts up, so the same text said twice is a new line. */
  n: number;
}

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
  /** The name (already truncated) of the person I follow, as it was when I pressed Follow. */
  leaderName: string | null;
  /** One plain line: stopped, left, not here, already 10 following. */
  notice: Line | null;
  /** What the follow announcer says (polite, once each): start, stop, end, Bring to me sent. Never a viewport. */
  announce: Line | null;
  /** The seq of the last banner dismissed (Go there, Dismiss, Escape, its minute): 0 for none. */
  dismissed: number;
  /** When I last sent Bring to me (Date.now()), for the 5-second cooldown. Kept across reconnects. */
  bringSentAt: number | null;
}

const EMPTY: Omit<FollowState, "bringSentAt"> = {
  following: null,
  followers: 0,
  leader: null,
  ended: null,
  brought: null,
  leaderName: null,
  notice: null,
  announce: null,
  dismissed: 0,
};

export const useFollow = create<FollowState>()(() => ({ ...EMPTY, bringSentAt: null }));

let seq = 0;
let lines = 0;
const line = (text: string): Line => ({ text, n: ++lines });

/** The store as the session's sink. */
export const followSink: FollowSink = {
  following: (id) => useFollow.setState(id === null ? { following: null, leader: null } : { following: id, leader: null, ended: null, notice: null }),
  followers: (count) => useFollow.setState({ followers: count }),
  viewport: (view) => useFollow.setState({ leader: view }),
  ended: (reason) =>
    useFollow.setState((s) => {
      const text = followEndText(reason, s.leaderName);
      return { following: null, leader: null, ended: reason, leaderName: null, notice: line(text), announce: line(text) };
    }),
  brought: (view) => useFollow.setState({ brought: { ...view, seq: ++seq } }),
  // Everything but the Bring to me cooldown (the relay's budget doesn't care that I reconnected).
  clear: () => useFollow.setState({ ...EMPTY }),
};

/** I pressed Follow and the session sent followStart: keep the name, say it once. */
export function followStarted(name: string): void {
  useFollow.setState({ leaderName: name, notice: null, announce: line(FOLLOW_TEXT.started(name)) });
}

/** I stopped following (Stop, my own pan or zoom, Go there) and the session sent followStop: say so once. */
export function followStopped(): void {
  const name = useFollow.getState().leaderName;
  if (name === null) return;
  const text = FOLLOW_TEXT.stopped(name);
  useFollow.setState({ leaderName: null, notice: line(text), announce: line(text) });
}

/** The plain notice's time is up. */
export function clearFollowNotice(notice: Line): void {
  if (useFollow.getState().notice === notice) useFollow.setState({ notice: null });
}

/** I brought everyone to my view: the cooldown starts, said once. */
export function bringSent(now: number): void {
  useFollow.setState({ bringSentAt: now, announce: line(BRING_TEXT.sent) });
}

/** The banner showing now is dismissed (a newer Bring to me shows again). */
export function dismissBrought(): void {
  const brought = useFollow.getState().brought;
  if (brought) useFollow.setState({ dismissed: brought.seq });
}
