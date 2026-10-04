import type { Participant } from "@stickyard/shared";
import { create } from "zustand";
import { countUnread } from "../chat/unread";
import type { EchoEntry } from "./session";

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
