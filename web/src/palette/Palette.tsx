import { Search, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import type { Size, XY } from "../canvas/geometry";
import { Button } from "../components/ui/button";
import { readPxToken } from "../lib/cssVar";
import { cn } from "../lib/utils";
import { NOTE_COLOR_CLASSES } from "../notes/colours";
import { tileColumns } from "../panels/layout";
import {
  PALETTE_CATEGORIES,
  PALETTE_TABS,
  paletteSections,
  visibleTabs,
  type PaletteContext,
  type PaletteItem,
  type PalettePreview,
  type PaletteRoomState,
  type PaletteSurface,
} from "./registry";

/*
 * The palette's UI, built only from the registry (registry.ts), after Chalkline's palette:
 *   md and up: the palette panel's content (tabs when there's more than one, search, category
 *              sections as a tile grid that reflows with the panel's width);
 *   phones:    the add drawer, opened by Add note (tabs, search, one sideways-scrolling row
 *              per category), a non-modal bottom drawer like Chalkline's.
 * A tile adds its thing at the viewport centre when clicked, tapped or pressed with Enter or
 * Space, or can be dragged onto the board and dropped at the pointer. Pointer events, so mouse,
 * pen and touch behave the same.
 */

/** Where a tile's thing goes: the viewport centre, or a drop point on the board. */
export interface PaletteHost {
  ctx: PaletteContext;
  state: PaletteRoomState;
  /** Adds the item (at a board position, or the viewport centre). */
  activate(item: PaletteItem, at?: XY): void;
  /** Screen point -> board position for a drop (of something `size` big, a note if not given), or null when it's off the board. */
  dropAt(client: XY, size?: Size): XY | null;
}

/** Pointer travel (CSS px) before a press on a tile becomes a drag. */
const DRAG_THRESHOLD = 6;

function Preview({ preview, size }: { preview: PalettePreview; size: "tile" | "ghost" }) {
  if (preview.kind === "icon") {
    const Icon = preview.icon;
    return <Icon aria-hidden="true" className="size-icon-lg text-fg-muted" />;
  }
  return (
    <span
      aria-hidden="true"
      data-preview
      className={cn(
        "block size-tile-preview rounded-sm border border-border shadow-sm",
        NOTE_COLOR_CLASSES[preview.color],
        size === "ghost" && "shadow-lg",
      )}
    />
  );
}

/** The short name under a tile's preview: its label without a trailing " note" (the category says it). */
const shortLabel = (item: PaletteItem) => item.label.replace(/ note$/, "");

interface Ghost {
  item: PaletteItem;
  x: number;
  y: number;
}

/**
 * How a press on a tile becomes a drag. A mouse drags any way once it moves. On touch:
 *   "panel":  the list scrolls vertically, so a vertical move scrolls and a sideways one pulls
 *             the tile out;
 *   "drawer": rows scroll sideways and the drawer scrolls down, so moving scrolls, and press
 *             and hold (--sy-long-press) picks the tile up.
 */
type DragMode = "panel" | "drawer";

interface DragHooks {
  onDragStart?: () => void;
  /** After a drop or a cancel. */
  onDragEnd?: () => void;
}

function usePaletteDrag(host: PaletteHost, mode: DragMode, hooks: DragHooks = {}) {
  const [ghost, setGhost] = useState<Ghost | null>(null);
  const latest = useRef({ host, hooks });
  latest.current = { host, hooks };

  const tileProps = (item: PaletteItem) => ({
    onPointerDown(e: ReactPointerEvent<HTMLButtonElement>) {
      if ((e.pointerType === "mouse" && e.button !== 0) || item.disabled(latest.current.host.ctx) !== null) return;
      const touch = e.pointerType !== "mouse";
      const start = { x: e.clientX, y: e.clientY };
      const pointerId = e.pointerId;
      let dragging = false;

      const begin = (x: number, y: number) => {
        dragging = true;
        latest.current.hooks.onDragStart?.();
        setGhost({ item, x, y });
      };
      // Once a held tile is picked up, the page mustn't scroll under it.
      const blockScroll = (ev: TouchEvent) => {
        if (dragging && ev.cancelable) ev.preventDefault();
      };
      const hold = touch && mode === "drawer" ? window.setTimeout(() => begin(start.x, start.y), readPxToken("--sy-long-press", 500)) : 0;

      const stop = () => {
        window.clearTimeout(hold);
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", cancel);
        window.removeEventListener("touchmove", blockScroll);
        setGhost(null);
        if (dragging) latest.current.hooks.onDragEnd?.();
      };
      const move = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        if (dragging) return setGhost({ item, x: ev.clientX, y: ev.clientY });
        const dx = Math.abs(ev.clientX - start.x);
        const dy = Math.abs(ev.clientY - start.y);
        if (Math.hypot(dx, dy) <= DRAG_THRESHOLD) return;
        // On touch, moving before a hold (drawer) or along the list (panel) scrolls: neither a drag nor a tap.
        if (touch && (mode === "drawer" || dy >= dx)) return stop();
        begin(ev.clientX, ev.clientY);
      };
      const up = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        const wasDragging = dragging;
        stop();
        const h = latest.current.host;
        if (item.disabled(h.ctx) !== null) return;
        if (!wasDragging) return h.activate(item);
        const at = h.dropAt({ x: ev.clientX, y: ev.clientY }, item.dropSize);
        if (at) h.activate(item, at);
      };
      const cancel = (ev: PointerEvent) => {
        if (ev.pointerId === pointerId) stop();
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", cancel);
      if (hold) window.addEventListener("touchmove", blockScroll, { passive: false });
    },
    onContextMenu(e: ReactMouseEvent<HTMLButtonElement>) {
      // Press and hold drags; don't let the browser open its own menu.
      if (mode === "drawer") e.preventDefault();
    },
    onClick(e: ReactMouseEvent<HTMLButtonElement>) {
      // Pointer presses are handled above; this is keyboard activation (Enter or Space).
      if (e.detail === 0 && item.disabled(latest.current.host.ctx) === null) latest.current.host.activate(item);
    },
  });

  const ghostElement =
    ghost &&
    createPortal(
      <div aria-hidden="true" className="pointer-events-none fixed z-50 -translate-x-1/2 -translate-y-1/2" style={{ left: ghost.x, top: ghost.y }}>
        <Preview preview={ghost.item.preview} size="ghost" />
      </div>,
      document.body,
    );

  return { tileProps, ghostElement };
}

type TileProps = ReturnType<ReturnType<typeof usePaletteDrag>["tileProps"]>;

function Tile({ item, reason, props, row = false }: { item: PaletteItem; reason: string | null; props: TileProps; row?: boolean }) {
  return (
    <button
      type="button"
      data-palette-item={item.id}
      aria-label={item.label}
      title={reason ? `${item.label}: ${reason}` : `Add a ${item.label.toLowerCase()}`}
      disabled={reason !== null}
      className={cn(
        "flex min-h-touch min-w-0 cursor-pointer flex-col items-center justify-center gap-xs rounded-md border border-border bg-surface px-xs py-sm",
        "text-xs text-fg-muted transition-colors select-none hover:bg-surface-muted active:bg-accent-subtle",
        row ? "w-row-tile shrink-0 touch-manipulation [-webkit-touch-callout:none]" : "touch-pan-y",
        "disabled:cursor-not-allowed disabled:opacity-50",
      )}
      {...props}
    >
      <Preview preview={item.preview} size="tile" />
      <span className="max-w-full truncate">{shortLabel(item)}</span>
    </button>
  );
}

function Sections({
  host,
  tab,
  query,
  columns,
  tileProps,
  rows = false,
}: {
  host: PaletteHost;
  tab: string;
  query: string;
  columns: number;
  tileProps: (item: PaletteItem) => TileProps;
  /** Phones: one sideways-scrolling row per category instead of a grid. */
  rows?: boolean;
}) {
  const id = useId();
  const sections = paletteSections(PALETTE_CATEGORIES, tab, host.state, query, rows ? "drawer" : "panel");
  if (sections.length === 0) {
    return <p className="text-sm text-fg-muted">No matches for “{query.trim()}”.</p>;
  }
  return (
    <>
      {sections.map(({ category, items }) => (
        <section key={category.id} aria-labelledby={`${id}-${category.id}`} className="flex flex-col gap-sm">
          <h3 id={`${id}-${category.id}`} className="text-xs font-semibold tracking-wide text-fg-muted uppercase">
            {category.label}
          </h3>
          {rows ? (
            <div className="sy-scroll-hidden -mx-md flex gap-sm overflow-x-auto px-md pb-xs">
              {items.map((item) => (
                <Tile key={item.id} item={item} reason={item.disabled(host.ctx)} props={tileProps(item)} row />
              ))}
            </div>
          ) : (
            <div className="grid gap-sm" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
              {items.map((item) => (
                <Tile key={item.id} item={item} reason={item.disabled(host.ctx)} props={tileProps(item)} />
              ))}
            </div>
          )}
        </section>
      ))}
    </>
  );
}

function Tabs({ tabs, value, onChange }: { tabs: { id: string; label: string }[]; value: string; onChange: (id: string) => void }) {
  return (
    <div role="tablist" aria-label="Palette" className="flex shrink-0 gap-xs rounded-md bg-surface-muted p-xs">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={value === t.id}
          onClick={() => onChange(t.id)}
          className={cn(
            "min-h-touch flex-1 cursor-pointer rounded-sm text-sm font-medium transition-colors",
            value === t.id ? "bg-surface text-fg shadow-sm" : "text-fg-muted hover:text-fg",
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

function SearchField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <label className="relative block">
      <span className="sr-only">Search the palette</span>
      <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-ms size-icon -translate-y-1/2 text-fg-muted" />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search"
        autoComplete="off"
        className="h-touch w-full min-w-0 rounded-md border border-border-strong bg-surface pr-ms pl-xl text-base text-fg placeholder:text-fg-muted focus-visible:border-focus"
      />
    </label>
  );
}

/** The registry's tabs that have something in them, and the one showing. */
function useTabs(host: PaletteHost, surface: PaletteSurface) {
  const [tab, setTab] = useState("add");
  const tabs = visibleTabs(PALETTE_TABS, PALETTE_CATEGORIES, host.state, surface);
  const current = tabs.some((t) => t.id === tab) ? tab : (tabs[0]?.id ?? "add");
  return { tabs, current, setTab };
}

/** md and up: the palette panel's content (inside the SidePanel frame). */
export function PaletteContent({ host, width, collapse }: { host: PaletteHost; width: number; collapse: ReactNode }) {
  const [query, setQuery] = useState("");
  const { tabs, current, setTab } = useTabs(host, "panel");
  const { tileProps, ghostElement } = usePaletteDrag(host, "panel");
  const reason = host.ctx.noteReason;

  return (
    <div className="flex flex-col gap-md p-md">
      {/* Chalkline's palette header: the tabs (or, with one, its name in the same segmented style) and collapse. */}
      <div className="flex items-center gap-xs">
        <div className="min-w-0">
          {tabs.length > 1 ? (
            <Tabs tabs={tabs} value={current} onChange={setTab} />
          ) : (
            <div className="inline-flex rounded-md bg-surface-muted p-xs">
              <h2 className="flex min-h-touch items-center rounded-sm bg-surface px-ms text-sm font-medium shadow-sm">Palette</h2>
            </div>
          )}
        </div>
        {collapse}
      </div>
      <SearchField value={query} onChange={setQuery} />
      {reason && (
        <p role="status" className="text-sm text-fg-muted">
          {reason}
        </p>
      )}
      <Sections host={host} tab={current} query={query} columns={tileColumns(width)} tileProps={tileProps} />
      <p className="text-xs text-fg-muted">Click a tile to add it in the middle of the view, or drag it onto the board.</p>
      {ghostElement}
    </div>
  );
}

/**
 * md and up, palette collapsed: one column of compact tiles under the expand button (as in
 * Chalkline), still tap or drag to add, so collapsing never takes adding away.
 */
export function CompactPalette({ host }: { host: PaletteHost }) {
  const { tileProps, ghostElement } = usePaletteDrag(host, "panel");
  const sections = paletteSections(PALETTE_CATEGORIES, "add", host.state, "");
  return (
    <>
      {sections.map(({ category, items }, i) => (
        <div key={category.id} role="group" aria-label={category.label} className="flex flex-col items-center gap-xs">
          {i > 0 && <div aria-hidden="true" className="h-px w-touch bg-border" />}
          {items.map((item) => {
            const reason = item.disabled(host.ctx);
            return (
              <button
                key={item.id}
                type="button"
                data-palette-item={item.id}
                aria-label={item.label}
                title={reason ? `${item.label}: ${reason}` : `Add a ${item.label.toLowerCase()}`}
                disabled={reason !== null}
                className="flex size-touch shrink-0 cursor-pointer touch-pan-y items-center justify-center rounded-md transition-colors select-none hover:bg-surface-muted active:bg-accent-subtle disabled:cursor-not-allowed disabled:opacity-50"
                {...tileProps(item)}
              >
                <Preview preview={item.preview} size="tile" />
              </button>
            );
          })}
        </div>
      ))}
      {ghostElement}
    </>
  );
}

/**
 * Phones: Add note opens this drawer (after Chalkline's palette drawer). Non-modal: it slides up
 * from the bottom (at most --sy-drawer-max-h tall) over the board, which stays visible above
 * it. Tap a tile to add at the viewport centre; press and hold one to pick it up and drag it
 * onto the board (the drawer slides away while you drag). Adding closes it, as do X and Esc.
 * It stays mounted, so a drag keeps its pointer after the drawer hides; focus moves in on open
 * and back to Add note on close.
 */
export function AddDrawer({ host, open, onClose }: { host: PaletteHost; open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const headingId = useId();
  const [query, setQuery] = useState("");
  const [dragging, setDragging] = useState(false);
  const { tabs, current, setTab } = useTabs(host, "drawer");
  const { tileProps, ghostElement } = usePaletteDrag(host, "drawer", {
    onDragStart: () => setDragging(true),
    // Runs on drop and on cancel, so the drawer can never stay hidden.
    onDragEnd: () => setDragging(false),
  });
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const el = ref.current;
    if (!open || !el) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    el.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      close.current();
    };
    el.addEventListener("keydown", onKey);
    return () => {
      el.removeEventListener("keydown", onKey);
      setQuery("");
      // Back to Add note, unless focus has already moved on (to a note's editor, say).
      const back = opener && opener !== document.body && opener.isConnected ? opener : document.querySelector<HTMLElement>('[data-tool="note"]');
      if (document.activeElement === document.body || el.contains(document.activeElement)) back?.focus();
    };
  }, [open]);

  const tab = open ? 0 : -1;
  return (
    <div
      ref={ref}
      role={open ? "dialog" : undefined}
      aria-labelledby={headingId}
      aria-hidden={!open}
      inert={!open}
      className={cn(
        "sy-safe-bottom fixed inset-x-0 bottom-0 z-40 flex max-h-(--sy-drawer-max-h) flex-col rounded-t-lg border-t border-border bg-surface text-fg shadow-lg",
        "transition-transform duration-(--sy-duration-base) ease-standard",
        open && !dragging ? "translate-y-0" : "translate-y-full",
        !open && "invisible",
      )}
    >
      <div className="flex min-h-touch shrink-0 items-center justify-between gap-sm pr-xs pl-md">
        <h2 id={headingId} tabIndex={-1} data-autofocus className="text-base font-semibold outline-none">
          Add note
        </h2>
        <Button variant="ghost" size="icon" aria-label="Close" title="Close (Esc)" tabIndex={tab} onClick={onClose}>
          <X />
        </Button>
      </div>
      <div className="flex shrink-0 flex-col gap-sm px-md pb-sm">
        {tabs.length > 1 && <Tabs tabs={tabs} value={current} onChange={setTab} />}
        <SearchField value={query} onChange={setQuery} />
        {host.ctx.noteReason && (
          <p role="status" className="text-sm text-fg-muted">
            {host.ctx.noteReason}
          </p>
        )}
      </div>
      <div className="sy-scroll-hidden flex min-h-0 flex-col gap-md overflow-y-auto overscroll-contain px-md pb-sm">
        <Sections host={host} tab={current} query={query} columns={1} tileProps={tileProps} rows />
        <p className="text-xs text-fg-muted">Tap a tile to add it, or press and hold one to drag it onto the board.</p>
      </div>
      {ghostElement}
    </div>
  );
}
