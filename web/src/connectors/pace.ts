import type { ClientMessage } from "@stickyard/shared";

/*
 * Pacing for connector messages (web only). The relay spends a per-socket token bucket on every
 * connector message (worker CONNECTOR_LIMITS: 4 a second, burst 100) and refuses one over it with
 * rate_limited. The page keeps its own, smaller bucket so that never happens: a burst of up to
 * CONNECTOR_PACE.burst goes at once (Clear board, a duplicated selection's arrows, an undo), the
 * rest follows at CONNECTOR_PACE.perSecond, a little under the relay's rate, so messages that
 * arrive bunched together still fit. The bucket is full again for every new socket (the relay's
 * is too). Clock and timers are injected, so it's tested on a fake clock.
 */

/** A little inside the relay's CONNECTOR_LIMITS (checked against the Worker's source in a test). */
export const CONNECTOR_PACE = { burst: 96, perSecond: 3.5 } as const;

export type ConnectorMessage = Extract<ClientMessage, { type: "connectorAdd" | "connectorUpdate" | "connectorDelete" }>;

export interface PacerOptions {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(id: unknown): void;
  send(message: ConnectorMessage): void;
  burst?: number;
  perSecond?: number;
}

export class ConnectorPacer {
  private tokens: number;
  private at: number;
  private queue: ConnectorMessage[] = [];
  private timer: unknown = undefined;
  private idle: (() => void)[] = [];
  private readonly burst: number;
  private readonly perSecond: number;

  constructor(private readonly options: PacerOptions) {
    this.burst = options.burst ?? CONNECTOR_PACE.burst;
    this.perSecond = options.perSecond ?? CONNECTOR_PACE.perSecond;
    this.tokens = this.burst;
    this.at = options.now();
  }

  /** Messages waiting for a token. */
  get queued(): number {
    return this.queue.length;
  }

  /** Sends now if there's a token and nothing waits ahead of it, else queues (in order). */
  enqueue(message: ConnectorMessage): void {
    this.queue.push(message);
    this.pump();
  }

  /** Runs `fn` once everything queued now has been sent (at once if nothing is queued). */
  whenSent(fn: () => void): void {
    if (this.queue.length === 0) return fn();
    this.idle.push(fn);
  }

  /** A new socket (or none): nothing queued is ever sent, waiting callbacks are dropped, and the bucket is full again. */
  reset(): void {
    if (this.timer !== undefined) this.options.clearTimer(this.timer);
    this.timer = undefined;
    this.queue = [];
    this.idle = [];
    this.tokens = this.burst;
    this.at = this.options.now();
  }

  private refill(): void {
    const now = this.options.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.at) / 1000) * this.perSecond);
    this.at = now;
  }

  private pump(): void {
    if (this.timer !== undefined) return;
    this.refill();
    while (this.queue.length > 0 && this.tokens >= 1) {
      this.tokens -= 1;
      this.options.send(this.queue.shift()!);
    }
    if (this.queue.length > 0) {
      const wait = Math.ceil(((1 - this.tokens) / this.perSecond) * 1000);
      this.timer = this.options.setTimer(() => {
        this.timer = undefined;
        this.pump();
      }, Math.max(1, wait));
      return;
    }
    const idle = this.idle;
    this.idle = [];
    for (const fn of idle) fn();
  }
}
