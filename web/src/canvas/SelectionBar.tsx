import { useId, type ReactNode } from "react";
import {
  AlignCenterHorizontal,
  Copy,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalDistributeCenter,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalDistributeCenter,
  LayoutGrid,
  Minus,
  MoveHorizontal,
  MoveVertical,
  Plus,
  Redo2,
  Scaling,
  Trash2,
  Undo2,
} from "lucide-react";
import type { NoteRect, OrderAction } from "@stickyard/shared";
import { Button } from "../components/ui/button";
import { Panel } from "../components/ui/panel";
import { ORDER_COMMANDS } from "../notes/OrderFields";
import { cn } from "../lib/utils";
import { GRID_GAP, align, autoColumns, distribute, grid, matchSize, type AlignMode, type Axis, type GridReason, type MatchMode, type Placed } from "./arrange";
import { useBoardUi } from "./uiStore";

/*
 * The floating bar at the top of the canvas (md and up), always there, in labelled groups:
 * History (Undo, Redo), Edit (Duplicate, Delete), Order (Bring to front, Send to back) and Arrange (Align,
 * Distribute, Grid with its Columns stepper, Match size: Chalkline's ArrangeBar). A command that
 * doesn't apply now is disabled, never hidden, and its group says why as text (each disabled
 * button points at that text with aria-describedby). History, Edit and Order show their names from lg up.
 */

export interface BarCommand {
  title: string;
  icon: ReactNode;
  disabled?: boolean;
  /** Shown instead of the title while disabled. */
  hint?: string;
  /** Shows the title as text next to the icon from lg up (it's always the accessible name). */
  text?: boolean;
  run: () => void;
}

export interface BarGroup {
  label: string;
  commands: BarCommand[];
  /** Controls of the group's own, after its commands; given the id of the group's hint text. */
  content?: (hintId: string | undefined) => ReactNode;
  /** Why commands in this group are off, shown as text after them (repeats are shown once). */
  hints?: (string | null)[];
}

/** One group's buttons (its hint text is rendered by the bar, under all the groups). */
function BarGroupView({ group, first, hintId, hints }: { group: BarGroup; first: boolean; hintId: string; hints: string[] }) {
  return (
    <div className="flex shrink-0 items-center xl:max-w-full xl:shrink">
      {!first && <div aria-hidden="true" className="mx-xs h-icon-lg w-px bg-border xl:hidden" />}
      {/* The group's name is its accessible name, and starts its line in the hints. */}
      <div role="group" aria-label={group.label} className="flex items-center gap-2xs xl:flex-wrap xl:justify-center">
        {group.commands.map((c) => (
          <Button
            key={c.title}
            variant="ghost"
            size={c.text ? "default" : "icon"}
            aria-label={c.title}
            title={c.disabled && c.hint ? c.hint : c.title}
            aria-describedby={c.disabled && hints.length > 0 ? hintId : undefined}
            disabled={c.disabled}
            onClick={c.run}
            className={cn(c.text && "min-w-touch px-sm")}
          >
            {c.icon}
            {c.text && <span className="hidden xl:inline">{c.title}</span>}
          </Button>
        ))}
        {group.content?.(hints.length > 0 ? hintId : undefined)}
      </div>
    </div>
  );
}

/**
 * A floating toolbar of labelled groups with dividers between them. The buttons sit in one row
 * that scrolls sideways when the canvas is narrow (and wraps from xl up); why anything is off is
 * one line of text under them, per group ("Edit: ..."), so the bar stays short.
 */
export function FloatingBar({ label, groups }: { label: string; groups: BarGroup[] }) {
  const baseId = useId();
  const hintsOf = (group: BarGroup) => [...new Set((group.hints ?? []).filter((h): h is string => h !== null))];
  return (
    <Panel role="toolbar" aria-label={label} className="pointer-events-auto flex max-w-full flex-col gap-2xs p-xs shadow-lg">
      <div className="flex max-w-full items-center overflow-x-auto xl:flex-wrap xl:justify-center xl:gap-x-md xl:overflow-visible">
        {groups.map((group, i) => (
          <BarGroupView key={group.label} group={group} first={i === 0} hintId={`${baseId}-${i}`} hints={hintsOf(group)} />
        ))}
      </div>
      {groups.some((g) => hintsOf(g).length > 0) && (
        <p className="px-xs text-xs text-fg-muted">
          {groups.map((group, i) => {
            const hints = hintsOf(group);
            if (hints.length === 0) return null;
            return (
              <span key={group.label} id={`${baseId}-${i}`} data-bar-hint="" className="mr-sm inline-block">
                <span className="font-medium">{group.label}:</span> {hints.join(" ")}
              </span>
            );
          })}
        </p>
      )}
    </Panel>
  );
}

const ALIGN: { mode: AlignMode; title: string; icon: ReactNode }[] = [
  { mode: "left", title: "Align left edges", icon: <AlignStartVertical /> },
  { mode: "centre", title: "Align centres horizontally", icon: <AlignCenterVertical /> },
  { mode: "right", title: "Align right edges", icon: <AlignEndVertical /> },
  { mode: "top", title: "Align top edges", icon: <AlignStartHorizontal /> },
  { mode: "middle", title: "Align centres vertically", icon: <AlignCenterHorizontal /> },
  { mode: "bottom", title: "Align bottom edges", icon: <AlignEndHorizontal /> },
];

const DISTRIBUTE: { axis: Axis; title: string; icon: ReactNode }[] = [
  { axis: "horizontal", title: "Distribute horizontally (equal gaps)", icon: <AlignHorizontalDistributeCenter /> },
  { axis: "vertical", title: "Distribute vertically (equal gaps)", icon: <AlignVerticalDistributeCenter /> },
];

const MATCH: { mode: MatchMode; title: string; icon: ReactNode }[] = [
  { mode: "width", title: "Match width to the first selected", icon: <MoveHorizontal /> },
  { mode: "height", title: "Match height to the first selected", icon: <MoveVertical /> },
  { mode: "both", title: "Match size to the first selected", icon: <Scaling /> },
];

export const DISTRIBUTE_HINT = "Select 3 or more notes to distribute.";

/** Why Grid is off, shown next to it. */
export const GRID_HINTS = {
  few: "Select 2 or more notes to arrange.",
  offline: "Not connected.",
  held: "Finish moving or resizing first.",
  unsaved: "Wait until new notes are saved.",
} as const;

/** The notice when a grid doesn't fit the board. */
export const GRID_NO_ROOM: Record<GridReason, string> = {
  wide: "That grid is too wide for the board. Try fewer columns.",
  tall: "That grid is too tall for the board. Try more columns.",
  big: "Those notes are too big to fit on the board in a grid.",
};

/** Grid needs 2+ notes, a connection, no note being moved or resized here, and every note saved (they can't move before). */
export function gridDisabledReason({ count, live, held, unsaved }: { count: number; live: boolean; held: boolean; unsaved: boolean }): string | null {
  if (count < 2) return GRID_HINTS.few;
  if (!live) return GRID_HINTS.offline;
  if (held) return GRID_HINTS.held;
  if (unsaved) return GRID_HINTS.unsaved;
  return null;
}

/**
 * Grid and its Columns stepper (1 to the count; Auto = autoColumns). The chosen count lives in
 * uiStore for the session, and is kept within the count of the current selection. Why Grid is
 * off is the Arrange group's hint (`hintId`).
 */
function GridControls({ notes, reason, hintId, onGrid }: { notes: Placed[]; reason: string | null; hintId: string | undefined; onGrid: (columns: number) => void }) {
  const chosen = useBoardUi((s) => s.gridColumns);
  const setColumns = useBoardUi((s) => s.setGridColumns);
  const count = Math.max(1, notes.length);
  const auto = notes.length > 0 ? autoColumns(notes) : 1;
  const columns = chosen === null ? auto : Math.min(Math.max(1, chosen), count);
  return (
    <>
      <Button variant="ghost" title="Lay out in a grid" aria-describedby={reason ? hintId : undefined} disabled={reason !== null} onClick={() => onGrid(columns)} className="px-sm">
        <LayoutGrid />
        Grid
      </Button>
      <div role="group" aria-label="Columns" className="flex items-center">
        <span className="px-xs text-xs text-fg-muted">Columns</span>
        <Button variant="ghost" size="icon" aria-label="Fewer columns" title="Fewer columns" aria-describedby={columns <= 1 ? hintId : undefined} disabled={columns <= 1} onClick={() => setColumns(columns - 1)}>
          <Minus />
        </Button>
        <output data-grid-columns="" aria-live="polite" className="min-w-touch text-center text-sm tabular-nums">
          {chosen === null ? `Auto (${columns})` : columns}
        </output>
        <Button variant="ghost" size="icon" aria-label="More columns" title="More columns" aria-describedby={columns >= count ? hintId : undefined} disabled={columns >= count} onClick={() => setColumns(columns + 1)}>
          <Plus />
        </Button>
        <Button
          variant="ghost"
          aria-label="Automatic columns"
          title="Choose columns from the selection’s shape"
          aria-pressed={chosen === null}
          className={cn("px-sm", chosen === null && "bg-surface-muted")}
          onClick={() => setColumns(null)}
        >
          Auto
        </Button>
      </div>
    </>
  );
}

/** Why Order is off: frames always sit behind notes, so only notes restack. */
export const ORDER_HINTS = {
  none: "Select notes to restack them.",
  frame: "Frames always sit behind notes.",
  offline: "Not connected.",
} as const;

/** Why Delete is off. */
export const DELETE_HINTS = {
  none: "Select notes or a frame first.",
  offline: "Not connected.",
} as const;

export interface BoardBarProps {
  /** Selected notes, in selection order (the first is Match size's reference). */
  notes: Placed[];
  /** A frame is selected (instead of notes). */
  frame: boolean;
  live: boolean;
  /** A selected note is being moved or resized here. */
  held: boolean;
  /** A selected note has no server id yet. */
  unsaved: boolean;
  /** Why Duplicate is off (canvas/duplicate.ts), or null. */
  duplicateReason: string | null;
  duplicate: () => void;
  /** Why Undo and Redo are off (the room's history), or null each. */
  undoReason: string | null;
  redoReason: string | null;
  undo: () => void;
  redo: () => void;
  /** Deletes the selection (notes or the frame), asking as the Delete key does. */
  remove: () => void;
  apply: (rects: (NoteRect & { id: string })[]) => void;
  order: (action: OrderAction) => void;
  notice: (text: string) => void;
}

/**
 * The bar's groups for the current selection. Edit: Duplicate and Delete. Order: Bring to front
 * and Send to back for notes. Arrange (2+ notes; Distribute 3+): `apply` sends the changed rects;
 * `notice` tells why a grid didn't fit. Everything is off while disconnected; Grid also while a
 * note in the selection is held or unsaved.
 */
export function BoardBar({ notes, frame, live, held, unsaved, duplicateReason, duplicate, undoReason, redoReason, undo, redo, remove, apply, order, notice }: BoardBarProps) {
  const send = (changes: Map<string, NoteRect>) => apply([...changes].map(([id, rect]) => ({ id, ...rect })));
  const count = notes.length;
  const canArrange = live && count >= 2;
  const canDistribute = canArrange && count >= 3;
  const gridReason = gridDisabledReason({ count, live, held, unsaved });
  const runGrid = (columns: number) => {
    const result = grid(notes, columns, GRID_GAP);
    if (result.reason) notice(GRID_NO_ROOM[result.reason]);
    else send(result.changes);
  };
  const deleteReason = count === 0 && !frame ? DELETE_HINTS.none : !live ? DELETE_HINTS.offline : null;
  const orderReason = count === 0 ? (frame ? ORDER_HINTS.frame : ORDER_HINTS.none) : !live ? ORDER_HINTS.offline : null;
  const arrangeHints = [gridReason, count === 2 && live ? DISTRIBUTE_HINT : null];
  return (
    <FloatingBar
      label="Board actions"
      groups={[
        {
          label: "History",
          commands: [
            { title: "Undo", icon: <Undo2 />, text: true, disabled: undoReason !== null, ...(undoReason ? { hint: undoReason } : {}), run: undo },
            { title: "Redo", icon: <Redo2 />, text: true, disabled: redoReason !== null, ...(redoReason ? { hint: redoReason } : {}), run: redo },
          ],
          hints: [undoReason, redoReason],
        },
        {
          label: "Edit",
          commands: [
            { title: "Duplicate", icon: <Copy />, text: true, disabled: duplicateReason !== null, ...(duplicateReason ? { hint: duplicateReason } : {}), run: duplicate },
            { title: "Delete", icon: <Trash2 />, text: true, disabled: deleteReason !== null, ...(deleteReason ? { hint: deleteReason } : {}), run: remove },
          ],
          hints: [duplicateReason, deleteReason],
        },
        {
          label: "Order",
          commands: ORDER_COMMANDS.map((c) => ({ title: c.label, icon: c.icon, text: true, disabled: orderReason !== null, run: () => order(c.action) })),
          hints: [orderReason],
        },
        {
          label: "Arrange",
          commands: [
            ...ALIGN.map((a) => ({ ...a, disabled: !canArrange, run: () => send(align(notes, a.mode)) })),
            ...DISTRIBUTE.map((d) => ({ ...d, disabled: !canDistribute, ...(count === 2 ? { hint: DISTRIBUTE_HINT } : {}), run: () => send(distribute(notes, d.axis)) })),
            ...MATCH.map((m) => ({ ...m, disabled: !canArrange, run: () => send(matchSize(notes, m.mode)) })),
          ],
          content: (hintId) => <GridControls notes={notes} reason={gridReason} hintId={hintId} onGrid={runGrid} />,
          hints: arrangeHints,
        },
      ]}
    />
  );
}
