import { ArrowLeft, X } from "lucide-react";
import { useEffect, useId, useRef, type PointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button } from "../components/ui/button";
import { readPxToken } from "../lib/cssVar";
import { trapFocus } from "../lib/focusTrap";

/*
 * The sheet frame used by Help, What's new and About (Chalkline's pattern).
 * Phone: a full-height bottom sheet with a grab handle. From md up: a side panel on the right.
 * Modal: focus moves in and stays inside, Escape or the X closes, tapping outside closes,
 * swiping the header down closes on touch, and focus returns to the opener on close.
 * The frame stays mounted while moving between sheets; `page` changing moves focus to the
 * new title (so screen readers announce it) and scrolls back to the top.
 */
export function Sheet({
  title,
  icon,
  page,
  onClose,
  onBack,
  children,
}: {
  title: string;
  icon: ReactNode;
  /** Identifies the page shown, e.g. its hash. */
  page: string;
  onClose: () => void;
  /** Shows a back arrow in place of the icon. */
  onBack?: (() => void) | undefined;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const titleId = useId();
  const close = useRef(onClose);
  close.current = onClose;
  const shown = useRef(page);
  const swipe = useRef<{ id: number; y: number } | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return trapFocus<HTMLElement>(el, document, () => close.current());
  }, []);

  useEffect(() => {
    if (shown.current === page) return;
    shown.current = page;
    bodyRef.current?.scrollTo?.({ top: 0 });
    titleRef.current?.focus();
  }, [page]);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "mouse" || (e.target as HTMLElement).closest("button")) return;
    swipe.current = { id: e.pointerId, y: e.clientY };
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const start = swipe.current;
    swipe.current = null;
    if (start?.id === e.pointerId && e.clientY - start.y > readPxToken("--sy-swipe-close", 80)) onClose();
  };

  return createPortal(
    <div
      className="sy-fade-in fixed inset-0 z-50 flex items-end bg-overlay md:items-stretch md:justify-end"
      onPointerDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="sy-sheet-in flex h-(--sy-full-sheet-h) w-full flex-col rounded-t-lg border-t border-border bg-surface text-fg shadow-lg md:sy-safe-top md:h-full md:max-w-sheet md:rounded-none md:border-t-0 md:border-l"
      >
        <div
          className="shrink-0 touch-none border-b border-border md:touch-auto"
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
          onPointerCancel={() => (swipe.current = null)}
        >
          <div aria-hidden="true" className="flex justify-center pt-sm md:hidden">
            <span className="h-handle-h w-handle-w rounded-full bg-border-strong" />
          </div>
          <div className="flex min-h-touch items-center gap-xs px-xs">
            {onBack ? (
              <Button variant="ghost" size="icon" aria-label="Back" title="Back" onClick={onBack}>
                <ArrowLeft />
              </Button>
            ) : (
              <span aria-hidden="true" className="flex size-touch items-center justify-center text-fg-muted [&_svg]:size-icon">
                {icon}
              </span>
            )}
            <h2 ref={titleRef} id={titleId} tabIndex={-1} className="min-w-0 flex-1 truncate text-sm font-semibold outline-none">
              {title}
            </h2>
            <Button variant="ghost" size="icon" aria-label="Close" title="Close (Esc)" onClick={onClose}>
              <X />
            </Button>
          </div>
        </div>
        <div ref={bodyRef} className="sy-safe-bottom min-h-0 flex-1 overflow-y-auto overscroll-contain px-md pt-md">
          {children}
        </div>
      </div>
    </div>,
    document.body,
  );
}
