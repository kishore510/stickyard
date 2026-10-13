/*
 * Focus trapping for modal sheets: focus moves in on open (to `[data-autofocus]` if
 * present), Tab and Shift+Tab cycle inside, Escape calls `onEscape`, and focus returns
 * to where it was on release. Written against minimal interfaces so it can be unit tested.
 * Traps stack (v0.32.0: Share session opens over Participants): only the newest one handles
 * keys, so Escape closes the top sheet alone and the one under it takes over once it's released.
 */

const active: object[] = [];

export const FOCUSABLE =
  'a[href], button:not([disabled]), summary, input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface Focusable {
  focus: (options?: FocusOptions) => void;
}

export interface FocusContainer<T extends Focusable> {
  querySelector: (selector: string) => T | null;
  querySelectorAll: (selector: string) => ArrayLike<T>;
}

export interface FocusDocument {
  activeElement: unknown;
  addEventListener(type: "keydown", listener: (e: KeyboardEvent) => void, capture: boolean): void;
  removeEventListener(type: "keydown", listener: (e: KeyboardEvent) => void, capture: boolean): void;
}

/** Where Tab (or Shift+Tab) should go, or null to let the browser move focus normally. */
export function tabTarget<T>(items: readonly T[], active: unknown, shift: boolean): T | null {
  const head = items[0];
  const tail = items.at(-1);
  if (head === undefined || tail === undefined) return null;
  const index = items.indexOf(active as T);
  if (index === -1) return shift ? tail : head;
  if (shift && index === 0) return tail;
  if (!shift && index === items.length - 1) return head;
  return null;
}

/** Starts trapping focus in `container`. Returns a release function that restores focus. */
export function trapFocus<T extends Focusable>(
  container: FocusContainer<T>,
  doc: FocusDocument,
  onEscape: () => void,
): () => void {
  const previous = doc.activeElement as (Partial<Focusable> & { isConnected?: boolean }) | null;
  (container.querySelector("[data-autofocus]") ?? container.querySelector(FOCUSABLE))?.focus();
  const token = {};
  active.push(token);

  const onKeyDown = (e: KeyboardEvent) => {
    if (active.at(-1) !== token) return;
    if (e.key === "Escape") {
      e.stopPropagation();
      onEscape();
      return;
    }
    if (e.key !== "Tab") return;
    const target = tabTarget(Array.from(container.querySelectorAll(FOCUSABLE)), doc.activeElement, e.shiftKey);
    if (!target) return;
    e.preventDefault();
    target.focus();
  };

  doc.addEventListener("keydown", onKeyDown, true);
  return () => {
    doc.removeEventListener("keydown", onKeyDown, true);
    const at = active.indexOf(token);
    if (at !== -1) active.splice(at, 1);
    if (previous?.isConnected !== false) previous?.focus?.();
  };
}
