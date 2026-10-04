import { CLEAR_HINTS } from "../properties/clearBoard";

/*
 * The board lock and End session (facilitation UI, protocol v12 messages; web only). Pure rules
 * and texts, so tested. The relay is the authority: a guest's change on a locked board is refused
 * there (board_locked, rolled back here); this is courtesy UI that says so before anyone tries.
 */

export const LOCK_TEXT = {
  /** The guest's banner while locked (no dismiss). */
  banner: "The host has locked the board. You can still chat and look around.",
  /** Why a control is off for a guest while locked. */
  reason: "The board is locked by the host.",
  unlocked: "The host unlocked the board. You can edit again.",
  hostLocked: "Board locked. Only hosts can change it now.",
  hostUnlocked: "Board unlocked.",
  lock: "Lock board",
  unlock: "Unlock board",
  locking: "Locking…",
  unlocking: "Unlocking…",
  /** The host's marker while locked. */
  locked: "Locked",
  pending: "Waiting for the relay.",
  offline: "Not connected.",
} as const;

/** A guest on a locked board: their changes would be refused. Hosts are never locked out. */
export const lockedOut = (s: { locked: boolean; isHost: boolean }) => s.locked && !s.isHost;

/**
 * A control's reason for a guest on a locked board, on top of its own: while disconnected the
 * connection is the reason; otherwise the lock wins over anything else.
 */
export function withLock(reason: string | null, s: { live: boolean; locked: boolean; isHost: boolean }): string | null {
  return s.live && lockedOut(s) ? LOCK_TEXT.reason : reason;
}

/** The host's Lock / Unlock toggle: its label and why it's off (waiting for the relay, disconnected). */
export function lockToggle(s: { locked: boolean; pending: boolean | null; live: boolean }): { label: string; reason: string | null } {
  if (s.pending !== null) return { label: s.pending ? LOCK_TEXT.locking : LOCK_TEXT.unlocking, reason: LOCK_TEXT.pending };
  return { label: s.locked ? LOCK_TEXT.unlock : LOCK_TEXT.lock, reason: s.live ? null : LOCK_TEXT.offline };
}

/** What to announce when the lock changes (null: it didn't). */
export function lockAnnouncement(prev: boolean | null, next: boolean, isHost: boolean): string | null {
  if (prev === null || prev === next) return null;
  if (isHost) return next ? LOCK_TEXT.hostLocked : LOCK_TEXT.hostUnlocked;
  return next ? LOCK_TEXT.banner : LOCK_TEXT.unlocked;
}

export const END_SESSION_CONFIRM = "End this session for everyone? The board is deleted and can’t be restored.";

export const END_HINTS = {
  offline: "Not connected.",
  busy: CLEAR_HINTS.busy,
  clearing: CLEAR_HINTS.clearing,
} as const;

/** End session needs a connection and no run in progress (a template, a restore, a duplicate, a clear). */
export function endSessionReason(s: { live: boolean; busy: boolean; clearing: boolean }): string | null {
  if (!s.live) return END_HINTS.offline;
  if (s.clearing) return END_HINTS.clearing;
  return s.busy ? END_HINTS.busy : null;
}

/** One confirm stating the effect; no second prompt. */
export function confirmEndSession(confirm: (message: string) => boolean = (m) => window.confirm(m)): boolean {
  return confirm(END_SESSION_CONFIRM);
}
