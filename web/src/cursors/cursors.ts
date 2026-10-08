import { BOARD_HEIGHT, BOARD_WIDTH } from "@stickyard/shared";
import { truncateName } from "../presence/avatars";

/*
 * Live cursors (protocol v14): the pure rules. Sending (when, how often), the map of other
 * people's pointers (moved, idle, gone) and where a pointer is drawn. No timers or I/O here
 * except in CursorSender, whose clock and timers are injected.
 */

/** At most one cursor message this often (10 a second). */
export const CURSOR_SEND_INTERVAL_MS = 100;
/** A pointer must have moved this far (board units, either axis) since the last send. */
export const CURSOR_MIN_MOVE = 1;
/** Someone else's pointer fades out this long after it last moved. */
export const CURSOR_IDLE_MS = 5000;
/** Characters of a name shown beside a pointer (mirrored by --sy-cursor-label-max, test checks). */
export const CURSOR_LABEL_CHARS = 12;

export interface LastSent {
  at: number;
  x: number;
  y: number;
}

export type SendDecision = { kind: "send" } | { kind: "wait"; ms: number } | { kind: "skip" };

/** Send now, wait (then send the latest), or skip (not moved far enough). */
export function cursorDecision(last: LastSent | null, x: number, y: number, now: number): SendDecision {
  if (!last) return { kind: "send" };
  if (Math.abs(x - last.x) < CURSOR_MIN_MOVE && Math.abs(y - last.y) < CURSOR_MIN_MOVE) return { kind: "skip" };
  const since = now - last.at;
  return since < CURSOR_SEND_INTERVAL_MS ? { kind: "wait", ms: CURSOR_SEND_INTERVAL_MS - since } : { kind: "send" };
}

/**
 * By pointer type, never screen size: a mouse (some engines leave the type empty) or a pen
 * hovering. Touch never sends, and neither does a pen pressing, so a tap with a pen shares nothing.
 */
export function pointerMaySend({ pointerType, buttons }: { pointerType: string; buttons: number }): boolean {
  if (pointerType === "mouse" || pointerType === "") return true;
  return pointerType === "pen" && buttons === 0;
}

/** On the board itself (edges included). Off it, the cursor has left the board area. */
export function onBoardPoint(x: number, y: number): boolean {
  return Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0 && x <= BOARD_WIDTH && y <= BOARD_HEIGHT;
}

export interface CursorSenderDeps {
  now(): number;
  setTimer(fn: () => void, ms: number): number | ReturnType<typeof setTimeout>;
  clearTimer(id: number | ReturnType<typeof setTimeout> | undefined): void;
  /** Sends a position; false when the session wouldn't (nobody else here, hidden, not connected). */
  send(x: number, y: number): boolean;
  /** The pointer left: the session sends cursorLeft if the cursor was shown. */
  leave(): void;
}

/**
 * Throttles one pointer: a leading send, then at most one trailing send per interval with the
 * latest position. A refused send doesn't count, so the next move tries again.
 */
export class CursorSender {
  private last: LastSent | null = null;
  private pending: { x: number; y: number } | null = null;
  private timer: number | ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly deps: CursorSenderDeps) {}

  move(x: number, y: number): void {
    const decision = cursorDecision(this.last, x, y, this.deps.now());
    if (decision.kind === "skip") {
      this.pending = null;
      return;
    }
    if (decision.kind === "wait") {
      this.pending = { x, y };
      if (this.timer === undefined) this.timer = this.deps.setTimer(() => this.flush(), decision.ms);
      return;
    }
    this.sendNow(x, y);
  }

  leave(): void {
    this.cancel();
    this.last = null;
    this.deps.leave();
  }

  /** Forgets everything without telling anyone (unmount after leave, or a new socket). */
  cancel(): void {
    this.deps.clearTimer(this.timer);
    this.timer = undefined;
    this.pending = null;
  }

  private flush(): void {
    this.timer = undefined;
    const p = this.pending;
    this.pending = null;
    if (p) this.move(p.x, p.y);
  }

  private sendNow(x: number, y: number): void {
    this.deps.clearTimer(this.timer);
    this.timer = undefined;
    this.pending = null;
    if (this.deps.send(x, y)) this.last = { at: this.deps.now(), x, y };
  }
}

/* ── Other people's pointers ───────────────────────────────────────── */

export interface RemoteCursor {
  x: number;
  y: number;
  /** When it last moved (this device's clock). */
  at: number;
  /** Not moved for CURSOR_IDLE_MS: faded out until it moves again. */
  idle: boolean;
}
export type RemoteCursors = ReadonlyMap<string, RemoteCursor>;

export function moveCursor(map: RemoteCursors, id: string, x: number, y: number, now: number): RemoteCursors {
  const next = new Map(map);
  next.set(id, { x, y, at: now, idle: false });
  return next;
}

export function removeCursor(map: RemoteCursors, id: string): RemoteCursors {
  if (!map.has(id)) return map;
  const next = new Map(map);
  next.delete(id);
  return next;
}

/** Marks pointers that haven't moved for CURSOR_IDLE_MS; the same map when none changes. */
export function idleCursors(map: RemoteCursors, now: number): RemoteCursors {
  let next: Map<string, RemoteCursor> | null = null;
  for (const [id, c] of map) {
    if (c.idle || now - c.at < CURSOR_IDLE_MS) continue;
    next ??= new Map(map);
    next.set(id, { ...c, idle: true });
  }
  return next ?? map;
}

/** When the next pointer goes idle, or null when none will. */
export function nextIdleAt(map: RemoteCursors): number | null {
  let at: number | null = null;
  for (const c of map.values()) if (!c.idle) at = Math.min(at ?? Infinity, c.at + CURSOR_IDLE_MS);
  return at;
}

/** The visible part of the board, in board units. */
export interface VisibleArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Where a pointer is drawn: its point kept inside the visible area (leaving room for the arrow,
 * in screen px), the mark scaled by 1 / zoom so it keeps its screen size, and the label flipped to
 * the left when it would run past the right edge.
 */
export function placeCursor(
  at: { x: number; y: number },
  view: VisibleArea,
  zoom: number,
  reserve: { arrow: number; label: number },
): { x: number; y: number; scale: number; flip: boolean } {
  const scale = 1 / zoom;
  const arrow = reserve.arrow * scale;
  const right = view.x + view.width;
  const bottom = view.y + view.height;
  const x = Math.max(view.x, Math.min(at.x, right - arrow));
  const y = Math.max(view.y, Math.min(at.y, bottom - arrow));
  return { x, y, scale, flip: x + (reserve.arrow + reserve.label) * scale > right };
}

/** The name beside a pointer: plain text, at most CURSOR_LABEL_CHARS characters. */
export function cursorLabel(name: string): string {
  return truncateName(name, CURSOR_LABEL_CHARS);
}

/** Where the session hands other people's pointers (the cursor store, or a test's recorder). */
export interface CursorSink {
  moved(id: string, x: number, y: number): void;
  /** Their pointer left the board (cursorGone): the mark goes, the last known position stays (v0.24.0). */
  gone(id: string): void;
  /** They left the session: the mark and the last known position both go. */
  left(id: string): void;
  /** A new visit, a reconnect or a drop: everything goes. */
  clear(): void;
}

/* ── Last known positions (v0.24.0, jump to a person) ──────────────── */

/**
 * Each other person's last pointer position, by participant id, for Participants' Go to. Kept
 * apart from the cursor map: it survives the fade and cursorGone, and goes only when they leave or
 * on a new visit or reconnect. In memory only, never stored. Tracked whatever the Show switch says.
 */
export type LastPositions = ReadonlyMap<string, { x: number; y: number }>;

export function rememberPosition(map: LastPositions, id: string, x: number, y: number): LastPositions {
  const was = map.get(id);
  if (was && was.x === x && was.y === y) return map;
  const next = new Map(map);
  next.set(id, { x, y });
  return next;
}

export function forgetPosition(map: LastPositions, id: string): LastPositions {
  if (!map.has(id)) return map;
  const next = new Map(map);
  next.delete(id);
  return next;
}
