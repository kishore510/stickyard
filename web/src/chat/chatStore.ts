import { create } from "zustand";
import { STORAGE_KEYS, readKey, writeKey } from "../storage";
import { parseChatSize, serialiseChatSize, type ChatSize } from "./chatSize";

/*
 * The floating chat panel's size (md and up): null until it's resized (the token default).
 * Saved under a stickyard: key on release; layout only. Storage may be missing: then it's
 * kept for this visit only.
 */
interface ChatLayout {
  size: ChatSize | null;
  /** While dragging: shown, not saved. */
  preview(size: ChatSize): void;
  /** Shown and saved. Null resets to the default. */
  commit(size: ChatSize | null): void;
}

export const useChatLayout = create<ChatLayout>()((set) => ({
  size: parseChatSize(readKey(STORAGE_KEYS.chatPanel)),
  preview: (size) => set({ size }),
  commit: (size) => {
    set({ size });
    writeKey(STORAGE_KEYS.chatPanel, size ? serialiseChatSize(size) : "");
  },
}));
