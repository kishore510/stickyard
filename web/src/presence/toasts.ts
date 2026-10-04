import { truncateName } from "./avatars";

/*
 * Join and leave toasts (pure text). The session batches the events (TOAST_BATCH_MS), keeps
 * toasts apart (TOAST_GAP_MS) and leaves out yourself, the list you get on joining and the people
 * who come back after your own reconnect (RESYNC_QUIET_MS). Names are untrusted: plain text only,
 * truncated.
 */

export interface PresenceEvent {
  kind: "joined" | "left";
  id: string;
  name: string;
}

/** Events this close together are one toast (a burst of 20 people rejoining is one). */
export const TOAST_BATCH_MS = 1000;
/** Toasts are at least this far apart; events meanwhile wait for the next one. */
export const TOAST_GAP_MS = 2000;
/** How long a toast stays. */
export const TOAST_SHOW_MS = 5000;
/** After your own reconnect, people who were here before coming back aren't news for this long. */
export const RESYNC_QUIET_MS = 15_000;

const people = (n: number) => `${n} ${n === 1 ? "person" : "people"}`;

/**
 * One toast's text for a batch of events, or null when nothing is left to say: someone leaving
 * and coming back under the same name (their reconnect) cancels out, and so does someone joining
 * and leaving again within the batch.
 */
export function summarizePresence(events: readonly PresenceEvent[]): string | null {
  const left = events.map(() => true);
  events.forEach((e, i) => {
    if (!left[i]) return;
    const match = events.findIndex(
      (o, k) => k > i && left[k] && o.kind !== e.kind && (e.kind === "left" ? o.name === e.name : o.id === e.id),
    );
    if (match >= 0) {
      left[i] = false;
      left[match] = false;
    }
  });
  const rest = events.filter((_, i) => left[i]);
  const joins = rest.filter((e) => e.kind === "joined");
  const leaves = rest.filter((e) => e.kind === "left");
  const name = (e: PresenceEvent) => truncateName(e.name);
  if (joins.length + leaves.length === 0) return null;
  if (joins.length <= 1 && leaves.length <= 1) {
    return [joins[0] && `${name(joins[0])} joined`, leaves[0] && `${name(leaves[0])} left`].filter(Boolean).join(", ");
  }
  if (leaves.length === 0) return `${people(joins.length)} joined`;
  if (joins.length === 0) return `${people(leaves.length)} left`;
  return `${people(joins.length)} joined, ${leaves.length} left`;
}
