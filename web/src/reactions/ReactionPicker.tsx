import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { REACTION_KEYS } from "@stickyard/shared";
import { trapFocus } from "../lib/focusTrap";
import { useMediaQuery } from "../lib/useMediaQuery";
import { cn } from "../lib/utils";
import { useRoomUi } from "../rooms/roomStore";
import { MEDIA } from "../styles/breakpoints";
import { REACTIONS, REACTION_TEXT } from "./reactions";
import { setReaction } from "./reactionStore";

/** The popover's room from the window's edges, and from its button, in screen pixels. */
const EDGE_GAP = 8;

/**
 * Where the popover goes (fixed, in screen pixels): below the button, or above it when there's
 * more room there; shifted left so it stays inside the window. Null without layout.
 */
export function pickerPlacement(
  anchor: { left: number; top: number; bottom: number },
  panel: { width: number; height: number },
  area: { width: number; height: number },
): CSSProperties | null {
  if (area.width <= 0 || area.height <= 0) return null;
  const left = Math.max(EDGE_GAP, Math.min(anchor.left, area.width - EDGE_GAP - panel.width));
  const below = area.height - anchor.bottom - EDGE_GAP;
  const above = anchor.top - EDGE_GAP;
  const up = panel.height > below && above > below;
  return { left, top: up ? Math.max(EDGE_GAP, anchor.top - EDGE_GAP - panel.height) : anchor.bottom + EDGE_GAP };
}

/**
 * The reaction picker (v0.34.0): the six emoji, 44px each, named for screen readers, mine
 * pressed. From md up a popover by its button; on phones a bottom sheet (over the editor sheet
 * when opened from there). Modal either way: focus moves to the first emoji, Tab stays inside,
 * Esc or a press outside closes, and focus goes back to the button that opened it. Choosing one
 * sets it (one already mine stays on) and closes.
 */
export function ReactionPicker({ noteId, opener, onClose }: { noteId: string; opener: HTMLElement | null; onClose: () => void }) {
  const wide = useMediaQuery(MEDIA.tablet);
  const mine = useRoomUi((s) => s.room?.myReactions.get(noteId));
  const panelRef = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const [place, setPlace] = useState<CSSProperties | null>(null);

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!wide || !panel || !opener) return setPlace(null);
    setPlace(pickerPlacement(opener.getBoundingClientRect(), { width: panel.offsetWidth, height: panel.offsetHeight }, { width: window.innerWidth, height: window.innerHeight }));
  }, [wide, opener]);

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const release = trapFocus<HTMLElement>(panel, document, () => close.current());
    const down = (e: PointerEvent) => {
      if (!(e.target instanceof Node) || panel.contains(e.target) || opener?.contains(e.target)) return;
      close.current();
    };
    document.addEventListener("pointerdown", down, true);
    return () => {
      document.removeEventListener("pointerdown", down, true);
      release();
      // Back to the button that opened it, also where a click doesn't focus buttons (Safari).
      if (opener?.isConnected) opener.focus();
    };
  }, [opener]);

  const choose = (key: (typeof REACTION_KEYS)[number]) => {
    if (!mine?.has(key)) setReaction(noteId, key, true);
    onClose();
  };

  const panel = (
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-label={REACTION_TEXT.picker}
      data-reaction-picker=""
      data-variant={wide ? "popover" : "sheet"}
      style={wide ? (place ?? { left: EDGE_GAP, top: EDGE_GAP }) : undefined}
      className={cn(
        "border-border bg-surface text-fg shadow-lg",
        wide ? "fixed z-50 w-reaction-picker max-w-full rounded-md border p-xs" : "sy-sheet-in sy-safe-bottom w-full rounded-t-lg border-t px-md pt-sm",
      )}
    >
      {!wide && (
        <div aria-hidden="true" className="flex justify-center pb-sm">
          <span className="h-handle-h w-handle-w rounded-full bg-border-strong" />
        </div>
      )}
      {!wide && <p className="pb-xs text-sm font-semibold">{REACTION_TEXT.picker}</p>}
      <div className={cn("flex gap-xs", wide ? "flex-nowrap" : "flex-wrap justify-between pb-md")}>
        {REACTION_KEYS.map((key, i) => {
          const on = mine?.has(key) ?? false;
          return (
            <button
              key={key}
              type="button"
              data-reaction-option={key}
              data-autofocus={i === 0 || undefined}
              aria-label={REACTIONS[key].name}
              aria-pressed={on}
              title={REACTIONS[key].name}
              onClick={() => choose(key)}
              className="sy-reaction-chip size-touch p-0"
              data-mine={on || undefined}
            >
              <span aria-hidden="true" className="sy-reaction-emoji">
                {REACTIONS[key].emoji}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );

  return createPortal(
    wide ? (
      panel
    ) : (
      <div className="sy-fade-in fixed inset-0 z-50 flex items-end bg-overlay" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
        {panel}
      </div>
    ),
    document.body,
  );
}
