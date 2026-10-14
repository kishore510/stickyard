import { create } from "zustand";
import type { ReactionKey } from "@stickyard/shared";
import { useRoomUi } from "../rooms/roomStore";
import { reactionAnnouncement } from "./reactions";

/*
 * What the reactions announcer says (v0.34.0): only my own action, in memory, never stored. A
 * `seq` makes the same sentence twice a new announcement. Other people's reactions never get
 * here: only toggleReaction (a press of mine) writes it.
 */
interface ReactionUi {
  announce: { seq: number; text: string } | null;
  say(text: string): void;
  clear(): void;
}

export const useReactionUi = create<ReactionUi>()((set, get) => ({
  announce: null,
  say: (text) => set({ announce: { seq: (get().announce?.seq ?? 0) + 1, text } }),
  clear: () => set({ announce: null }),
}));

/**
 * Sets my reaction on a note on or off through the room (the session refuses with a notice when
 * it can't), and announces it politely when it went out. True when sent (or already so).
 */
export function setReaction(noteId: string, key: ReactionKey, on: boolean): boolean {
  const room = useRoomUi.getState().room;
  if (!room) return false;
  const was = room.myReactions.get(noteId)?.has(key) ?? false;
  const ok = room.reactionSet(noteId, key, on);
  if (ok && was !== on) useReactionUi.getState().say(reactionAnnouncement(key, on));
  return ok;
}
