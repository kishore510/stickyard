import type { EchoEntry } from "../rooms/session";

/** Messages from others with a key after `lastSeenKey` (keys only grow). Your own never count. */
export function countUnread(messages: readonly Pick<EchoEntry, "key" | "from">[], lastSeenKey: number, youId: string | undefined): number {
  return messages.filter((m) => m.key > lastSeenKey && m.from !== youId).length;
}
