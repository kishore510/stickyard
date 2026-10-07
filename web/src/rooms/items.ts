import { MAX_BATCH_ENTRIES, MAX_MESSAGE_BYTES, encodeMessage, utf8Length, type FrameItem, type NoteItem, type ShapeItem } from "@stickyard/shared";

/*
 * Packing items into itemsAdd messages (protocol v11), pure. Each message holds as many items as
 * fit by actual serialised size (UTF-8 bytes of the JSON, as the relay counts them) and at most
 * MAX_BATCH_ENTRIES. Items keep their order: across messages, and within each message's notes and
 * frames (a note's place in the list is its stacking order). Shapes (protocol v15) share the notes'
 * stacking space: a message with shapes gives every note and shape a `rank` (its place among them,
 * in the order given), so the relay stacks them as they were; messages without shapes are as before.
 */

export type ItemDraft = { kind: "note"; item: NoteItem } | { kind: "frame"; item: FrameItem } | { kind: "shape"; item: ShapeItem };

/** An itemsAdd as this page sends it (entries typed; empty lists left out). */
export interface ItemsAddMessage {
  type: "itemsAdd";
  clientRef: string;
  notes?: NoteItem[];
  frames?: FrameItem[];
  shapes?: ShapeItem[];
}

export interface PackedItems {
  messages: ItemsAddMessage[];
  /** Items that don't fit in a message even on their own (never the case for valid items; tested). */
  tooLarge: ItemDraft[];
}

const count = (m: ItemsAddMessage) => (m.notes?.length ?? 0) + (m.frames?.length ?? 0) + (m.shapes?.length ?? 0);

/** A message being packed, with its notes and shapes in the order they were given (for ranks). */
interface Built {
  message: ItemsAddMessage;
  stack: ("note" | "shape")[];
}

function withItem(built: Built, draft: ItemDraft): Built {
  const { message, stack } = built;
  if (draft.kind === "frame") return { message: { ...message, frames: [...(message.frames ?? []), draft.item] }, stack };
  if (draft.kind === "note") return { message: { ...message, notes: [...(message.notes ?? []), draft.item] }, stack: [...stack, "note"] };
  return { message: { ...message, shapes: [...(message.shapes ?? []), draft.item] }, stack: [...stack, "shape"] };
}

/** The message as sent: with shapes, every note and shape carries its rank (place among them). */
function ranked({ message, stack }: Built): ItemsAddMessage {
  if (!message.shapes?.length) return message;
  let n = 0;
  let s = 0;
  const notes = [...(message.notes ?? [])];
  const shapes = [...message.shapes];
  stack.forEach((kind, rank) => {
    if (kind === "note") {
      notes[n] = { ...notes[n]!, rank };
      n++;
    } else {
      shapes[s] = { ...shapes[s]!, rank };
      s++;
    }
  });
  return { ...message, ...(notes.length > 0 ? { notes } : {}), shapes };
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
  const fresh = (): Built => ({ message: { type: "itemsAdd", clientRef: newClientRef() }, stack: [] });
  let current = fresh();
  for (const draft of drafts) {
    const next = withItem(current, draft);
    if (count(next.message) <= MAX_BATCH_ENTRIES && messageBytes(ranked(next)) <= maxBytes) {
      current = next;
      continue;
    }
    if (count(current.message) > 0) {
      messages.push(ranked(current));
      current = fresh();
    }
    const alone = withItem(current, draft);
    if (messageBytes(ranked(alone)) <= maxBytes) current = alone;
    else tooLarge.push(draft);
  }
  if (count(current.message) > 0) messages.push(ranked(current));
  return { messages, tooLarge };
}
