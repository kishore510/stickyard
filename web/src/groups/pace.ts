import type { ClientMessage } from "@stickyard/shared";

/*
 * Pacing for group messages (web only), like connectors/pace.ts. The relay spends two per-socket
 * buckets on every group message (worker GROUP_LIMITS: 2 messages a second, burst 60; and one
 * member token per id a create or member change names, 10 a second, burst 250) and refuses one
 * over either with rate_limited. The page keeps its own, a little smaller, so that never happens:
 * Clear board's ungroups and its undo's re-creates go at once, anything past the bursts follows
 * at the refill rates. A message waits until both buckets hold what it costs (in order, never
 * overtaking). Full again for every new socket. Clock and timers are injected (tested on a fake clock).
 */

/** A little inside the relay's GROUP_LIMITS (checked against the Worker's source in a test). */
export const GROUP_PACE = { burst: 56, perSecond: 1.75, membersBurst: 240, membersPerSecond: 9 } as const;

export type GroupMessage = Extract<ClientMessage, { type: "groupCreate" | "groupUpdate" | "groupMembers" | "groupDelete" }>;

/** Member ids a message names (the relay's membersNamed). */
export const membersOf = (m: GroupMessage): number =>
  m.type === "groupCreate" ? m.members.length : m.type === "groupMembers" ? m.add.length + m.remove.length : 0;

export interface GroupPacerOptions {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(id: unknown): void;
  send(message: GroupMessage): void;
  pace?: { burst: number; perSecond: number; membersBurst: number; membersPerSecond: number };
}

export class GroupPacer {
  private tokens: number;
  private members: number;
  private at: number;
  private queue: GroupMessage[] = [];
  private timer: unknown = undefined;
  private idle: (() => void)[] = [];
  private readonly pace: { burst: number; perSecond: number; membersBurst: number; membersPerSecond: number };

  constructor(private readonly options: GroupPacerOptions) {
    this.pace = options.pace ?? GROUP_PACE;
    this.tokens = this.pace.burst;
    this.members = this.pace.membersBurst;
    this.at = options.now();
  }

  get queued(): number {
    return this.queue.length;
  }

  enqueue(message: GroupMessage): void {
    this.queue.push(message);
    this.pump();
  }

  /** Runs `fn` once everything queued now has been sent (at once if nothing is queued). */
  whenSent(fn: () => void): void {
    if (this.queue.length === 0) return fn();
    this.idle.push(fn);
  }

  /** A new socket (or none): nothing queued is ever sent, waiting callbacks are dropped, the buckets are full again. */
  reset(): void {
    if (this.timer !== undefined) this.options.clearTimer(this.timer);
    this.timer = undefined;
    this.queue = [];
    this.idle = [];
    this.tokens = this.pace.burst;
    this.members = this.pace.membersBurst;
    this.at = this.options.now();
  }

  private refill(): void {
    const now = this.options.now();
    const s = (now - this.at) / 1000;
    this.tokens = Math.min(this.pace.burst, this.tokens + s * this.pace.perSecond);
    this.members = Math.min(this.pace.membersBurst, this.members + s * this.pace.membersPerSecond);
    this.at = now;
  }

  private pump(): void {
    if (this.timer !== undefined) return;
    this.refill();
    while (this.queue.length > 0) {
      const cost = Math.min(membersOf(this.queue[0]!), this.pace.membersBurst);
      if (this.tokens < 1 || this.members < cost) break;
      this.tokens -= 1;
      this.members -= cost;
      this.options.send(this.queue.shift()!);
    }
    if (this.queue.length > 0) {
      const cost = Math.min(membersOf(this.queue[0]!), this.pace.membersBurst);
      const wait = Math.max(((1 - this.tokens) / this.pace.perSecond) * 1000, ((cost - this.members) / this.pace.membersPerSecond) * 1000);
      this.timer = this.options.setTimer(() => {
        this.timer = undefined;
        this.pump();
      }, Math.max(1, Math.ceil(wait)));
      return;
    }
    const idle = this.idle;
    this.idle = [];
    for (const fn of idle) fn();
  }
}
