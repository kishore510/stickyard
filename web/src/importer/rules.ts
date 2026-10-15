import { stencilReason } from "../stencils/rules";
import { UNDO_TEXT } from "../rooms/session";

/*
 * Import (v0.40.0): why it can't run now, with Duplicate's and stencils' reasons: not connected, a
 * guest on a locked board, a silent round (everyone), another add or restore still being sent.
 * Reasons are shown as text, never hidden.
 */
export function importReason({ live, lockedOut, silent, busy }: { live: boolean; lockedOut: boolean; silent: boolean; busy: boolean }): string | null {
  return stencilReason({ live, lockedOut, silent }) ?? (busy ? UNDO_TEXT.busy : null);
}
