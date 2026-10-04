import { MAX_BATCH_ENTRIES, MAX_MESSAGE_BYTES, encodeMessage, utf8Length, type FrameItem, type NoteItem } from "@stickyard/shared";

/*
 * Packing items into itemsAdd messages (protocol v11), pure. Each message holds as many items as
 * fit by actual serialised size (UTF-8 bytes of the JSON, as the relay counts them) and at most
 * MAX_BATCH_ENTRIES. Items keep their order: across messages, and within each message's notes and
 * frames (a note's place in the list is its stacking order).
 */

export type ItemDraft = { kind: "note"; item: NoteItem } | { kind: "frame"; item: FrameItem };

/** An itemsAdd as this page sends it (entries typed; empty lists left out). */
export interface ItemsAddMessage {
  type: "itemsAdd";
  clientRef: string;
  notes?: NoteItem[];
  frames?: FrameItem[];
}

export interface PackedItems {
  messages: ItemsAddMessage[];
  /** Items that don't fit in a message even on their own (never the case for valid items; tested). */
  tooLarge: ItemDraft[];
}

const count = (m: ItemsAddMessage) => (m.notes?.length ?? 0) + (m.frames?.length ?? 0);

function withItem(message: ItemsAddMessage, draft: ItemDraft): ItemsAddMessage {
  return draft.kind === "note"
    ? { ...message, notes: [...(message.notes ?? []), draft.item] }
    : { ...message, frames: [...(message.frames ?? []), draft.item] };
}

/** The message's size in UTF-8 bytes, as sent. */
export const messageBytes = (message: ItemsAddMessage) => utf8Length(encodeMessage(message));

/**
 * Packs `drafts` in order into as few messages as fit `maxBytes` each. `newClientRef` names each
 * message (it is part of the size, so it's drawn before measuring).
 */
export function packItems(drafts: readonly ItemDraft[], newClientRef: () => string, maxBytes: number = MAX_MESSAGE_BYTES): PackedItems {
  const messages: ItemsAddMessage[] = [];
  const tooLarge: ItemDraft[] = [];
  let current: ItemsAddMessage = { type: "itemsAdd", clientRef: newClientRef() };
  for (const draft of drafts) {
    const next = withItem(current, draft);
    if (count(next) <= MAX_BATCH_ENTRIES && messageBytes(next) <= maxBytes) {
      current = next;
      continue;
    }
    if (count(current) > 0) {
      messages.push(current);
      current = { type: "itemsAdd", clientRef: newClientRef() };
    }
    const alone = withItem(current, draft);
    if (messageBytes(alone) <= maxBytes) current = alone;
    else tooLarge.push(draft);
  }
  if (count(current) > 0) messages.push(current);
  return { messages, tooLarge };
}
