import { ChevronsLeft, ChevronsRight } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import { clampWidth, keyResize, shouldCollapse, type PanelSize } from "./layout";

/*
 * The frame both side panels use (md and up), after Chalkline's palette and Properties panels:
 * a header with the title and a collapse button (<< or >>), a body that scrolls on its own
 * (scrollbar hidden), and a resize handle on the edge facing the canvas. Collapsed, the panel
 * is a slim strip with an expand button (and, like Chalkline, a compact version of its content:
 * the palette's tiles, or a Properties button). Dragging the handle well past the minimum
 * collapses it. Widths come from panels/layout.ts; the layout itself
 * is saved by panels/panelStore.ts.
 */

/**
 * The resize handle: a vertical separator (focusable; arrow keys resize, Shift for bigger
 * steps, Home and End for the minimum and maximum; double-click resets; released well below the
 * minimum, the panel collapses). Pointer events, so a
 * mouse, pen or finger can drag it. The visible line is thin; the grab area is wider (a full
 * touch target on touch screens, see --sy-panel-handle).
 */
function Resizer({
  label,
  size,
  edge,
  onLive,
  onCommit,
  onReset,
  onCollapse,
}: {
  label: string;
  size: PanelSize;
  /** Which edge of the panel the handle is on. */
  edge: "left" | "right";
  /** Width while dragging (null: done). */
  onLive: (width: number | null) => void;
  onCommit: (width: number) => void;
  onReset: () => void;
  onCollapse: () => void;
}) {
  const drag = useRef<{ pointerId: number; x: number; width: number; last: number; raw: number } | null>(null);
  const [active, setActive] = useState(false);
  const end = (pointerId: number) => {
    const d = drag.current;
    if (!d || d.pointerId !== pointerId) return;
    drag.current = null;
    setActive(false);
    onLive(null);
    if (shouldCollapse(d.raw, size.min)) onCollapse();
    else if (d.last !== d.width) onCommit(d.last);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={size.width}
      aria-valuemin={size.min}
      aria-valuemax={size.max}
      tabIndex={0}
      title="Drag to resize. Double-click for the default width."
      onPointerDown={(e) => {
        if (e.pointerType === "mouse" && e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture?.(e.pointerId);
        drag.current = { pointerId: e.pointerId, x: e.clientX, width: size.width, last: size.width, raw: size.width };
        setActive(true);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d || d.pointerId !== e.pointerId) return;
        const dx = e.clientX - d.x;
        d.raw = d.width + (edge === "right" ? dx : -dx);
        d.last = clampWidth(d.raw, size.min, size.max);
        onLive(d.last);
      }}
      onPointerUp={(e) => end(e.pointerId)}
      onPointerCancel={(e) => end(e.pointerId)}
      onDoubleClick={onReset}
      onKeyDown={(e) => {
        const next = keyResize(size.width, e, size, edge);
        if (next === null) return;
        e.preventDefault();
        onCommit(next);
      }}
      className={cn(
        "group absolute inset-y-0 z-10 flex w-handle cursor-col-resize touch-none justify-center outline-none",
        edge === "right" ? "right-0 translate-x-1/2" : "left-0 -translate-x-1/2",
      )}
    >
      <div
        aria-hidden="true"
        className={cn(
          "h-full w-line transition-colors group-hover:bg-accent group-focus-visible:bg-accent",
          active ? "bg-accent" : "bg-transparent",
        )}
      />
    </div>
  );
}

export function SidePanel({
  label,
  name,
  side,
  size,
  collapsed,
  shortcut,
  onToggle,
  onWidth,
  strip,
  children,
}: {
  /** The panel's accessible name (its landmark). */
  label: string;
  /** In the collapse, expand and resize controls' names, e.g. "palette" (Collapse palette). */
  name: string;
  side: "left" | "right";
  size: PanelSize;
  collapsed: boolean;
  /** The key that toggles it, for the buttons' tooltips. */
  shortcut: string;
  onToggle: () => void;
  /** A new saved width (null: back to the default). */
  onWidth: (width: number | null) => void;
  /** What the collapsed strip shows under its expand button. */
  strip?: ReactNode;
  /**
   * The panel's content, given its collapse button to place in its own header (as in Chalkline:
   * the palette's header holds its tabs, Properties' a sticky tab row).
   */
  children: (collapseButton: ReactNode) => ReactNode;
}) {
  const [live, setLive] = useState<number | null>(null);
  const width = live ?? size.width;
  const Collapse = side === "left" ? ChevronsLeft : ChevronsRight;
  const Expand = side === "left" ? ChevronsRight : ChevronsLeft;
  const frame = cn("relative z-30 flex shrink-0 flex-col bg-surface text-fg", side === "left" ? "border-r border-border" : "border-l border-border");

  if (collapsed) {
    return (
      <aside aria-label={label} className={cn(frame, "sy-scroll-hidden w-strip items-center gap-xs overflow-y-auto py-xs")}>
        <Button variant="ghost" size="icon" aria-label={`Expand ${name}`} title={`Expand ${name} (${shortcut})`} aria-expanded={false} onClick={onToggle}>
          <Expand />
        </Button>
        {strip && (
          <>
            <div aria-hidden="true" className="h-px w-touch shrink-0 bg-border" />
            {strip}
          </>
        )}
      </aside>
    );
  }

  const collapseButton = (
    <Button variant="ghost" size="icon" aria-label={`Collapse ${name}`} title={`Collapse ${name} (${shortcut})`} aria-expanded onClick={onToggle}>
      <Collapse />
    </Button>
  );
  return (
    <aside aria-label={label} className={frame} style={{ width }}>
      <div className="sy-scroll-hidden min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain">{children(collapseButton)}</div>
      <Resizer
        label={`Resize ${name}`}
        size={{ ...size, width }}
        edge={side === "left" ? "right" : "left"}
        onLive={setLive}
        onCommit={(w) => onWidth(w)}
        onReset={() => {
          setLive(null);
          onWidth(null);
        }}
        onCollapse={onToggle}
      />
    </aside>
  );
}
