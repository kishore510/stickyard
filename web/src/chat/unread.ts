import type { EchoEntry } from "../rooms/session";

/** Messages from others with a key after `lastSeenKey` (keys only grow). Your own never count (under any id you've had). */
export function countUnread(
  messages: readonly Pick<EchoEntry, "key" | "from">[],
  lastSeenKey: number,
  you: string | ReadonlySet<string> | undefined,
): number {
  const mine = (from: string) => (typeof you === "string" ? from === you : (you?.has(from) ?? false));
  return messages.filter((m) => m.key > lastSeenKey && !mine(m.from)).length;
}
