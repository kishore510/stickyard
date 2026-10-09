import type { Participant, SilentState, VotingState } from "@stickyard/shared";
import { create } from "zustand";
import { countUnread } from "../chat/unread";
import type { EchoEntry, RoomTimer, VoteTotal } from "./session";
import type { ResultRow } from "../voting/voting";
import type { View } from "../follow/follow";

/*
 * The room the page is in, published by RoomScreen for things outside it: the top bar
 * (Participants and Chat buttons), the menu's Session group and the Participants sheet.
 * Null when not in a room. Plus whether chat is open and the last message seen there.
 * Names and messages are untrusted text, rendered as text only.
 */

export interface PublishedRoom {
  code: string;
  you: Participant | null;
  /** Every participant id you've had in this visit (a reconnect gives a new one). */
  yourIds: ReadonlySet<string>;
  participants: Participant[];
  live: boolean;
  messages: EchoEntry[];
  rateLimited: boolean;
  /** Protocol v12 (no visible host UI yet): host powers here, the lock and the timer. */
  isHost: boolean;
  locked: boolean;
  timer: RoomTimer | null;
  /** Host commands (facilitation UI); the session refuses them for guests and while disconnected. */
  startTimer(durationMs: number): boolean;
  stopTimer(): boolean;
  /** The lock the host asked for, until the relay answers (null: not waiting). */
  lockPending: boolean | null;
  setLock(locked: boolean): boolean;
  /** Why End session is off (disconnected, a run in progress), or null. */
  endReason: string | null;
  endSession(): boolean;
  /** Dot voting (protocol v13; the UI since v0.18.0): the state, my dots and the results (closed only). */
  voting: VotingState;
  isVoter: boolean;
  /** The relay said this round has its maximum of voters. */
  votersFull: boolean;
  myVotes: ReadonlyMap<string, number>;
  remaining: number;
  results: readonly VoteTotal[] | null;
  /** The results as the list shows them (sorted, with titles), while closed. */
  resultRows: readonly ResultRow[] | null;
  voteSet(noteId: string, count: number): boolean;
  /** Host only (the session refuses them for guests and while disconnected). */
  startVote(budget: number): boolean;
  stopVote(): boolean;
  clearVotes(): boolean;
  /** Silent brainstorm (protocol v17/v18; web state since v0.27.0, no UI yet): the round, my sealed note ids, everyone's note count, and whether this page can write in a round. */
  silent: SilentState;
  mySealed: ReadonlySet<string>;
  totalNotes: number;
  writer: boolean;
  /** The host's Start or Reveal waiting for the relay (part 3). */
  silentPending: "start" | "reveal" | null;
  /** Host only (the session refuses them for guests, while disconnected, or in the wrong state). */
  startSilent(): boolean;
  revealSilent(): boolean;
  /** Follow (v0.31.0): starts or stops following someone here (false: nothing sent). */
  startFollow(id: string): boolean;
  stopFollow(): boolean;
  /** Host only: brings everyone else to this view (false: nothing sent). */
  bringToMe(view: View): boolean;
  say(text: string): boolean;
  leave(): void;
}

interface RoomUi {
  room: PublishedRoom | null;
  chatOpen: boolean;
  /** Key of the newest message shown while chat was open (-1: none). */
  seenKey: number;
  publish(room: PublishedRoom | null): void;
  openChat(): void;
  closeChat(): void;
}

const lastKey = (room: PublishedRoom | null) => room?.messages.at(-1)?.key ?? -1;

export const useRoomUi = create<RoomUi>()((set, get) => ({
  room: null,
  chatOpen: false,
  seenKey: -1,
  publish: (room) =>
    set(room === null ? { room, chatOpen: false, seenKey: -1 } : { room, ...(get().chatOpen ? { seenKey: lastKey(room) } : {}) }),
  openChat: () => set({ chatOpen: true, seenKey: lastKey(get().room) }),
  closeChat: () => set({ chatOpen: false, seenKey: lastKey(get().room) }),
}));

/** Unread chat messages from others while chat is closed. */
export function useUnread(): number {
  return useRoomUi((s) => (s.room && !s.chatOpen ? countUnread(s.room.messages, s.seenKey, s.room.yourIds) : 0));
}
