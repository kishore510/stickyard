import { useId, type ReactNode } from "react";
import {
  AlignCenterHorizontal,
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
  Scaling,
} from "lucide-react";
import type { NoteRect, OrderAction } from "@stickyard/shared";
import { Button } from "../components/ui/button";
import { Panel } from "../components/ui/panel";
import { ORDER_COMMANDS } from "../notes/OrderFields";
import { cn } from "../lib/utils";
import { GRID_GAP, align, autoColumns, distribute, grid, matchSize, type AlignMode, type Axis, type GridReason, type MatchMode, type Placed } from "./arrange";
import { useBoardUi } from "./uiStore";

/*
 * The floating bar at the top of the canvas for a multi-selection (md and up, Select tool), as
 * Chalkline's ArrangeBar: Align, Distribute (3+ notes), Arrange (a labelled Grid button and its
 * Columns stepper), Match size and Order (front, back); the others one icon button per mode.
 * Built as a generic toolbar of groups, so a single-note toolbar can share it later.
 */

export interface BarCommand {
  title: string;
  icon: ReactNode;
  disabled?: boolean;
  /** Shown instead of the title while disabled. */
  hint?: string;
  run: () => void;
}

export interface BarGroup {
  label: string;
  commands: BarCommand[];
  /** Controls of the group's own, after its commands. */
  content?: ReactNode;
}

/** A floating toolbar of labelled groups with dividers between them. */
export function FloatingBar({ label, groups }: { label: string; groups: BarGroup[] }) {
  return (
    <Panel role="toolbar" aria-label={label} className="pointer-events-auto flex max-w-full flex-wrap items-center justify-center gap-x-xs p-xs shadow-lg">
      {groups.map((group, i) => (
        <div key={group.label} className="flex items-center">
          {i > 0 && <div aria-hidden="true" className="mx-xs h-icon-lg w-px bg-border" />}
          <div role="group" aria-label={group.label} className="flex items-center gap-2xs">
            <span className="px-xs text-xs font-medium text-fg-muted">{group.label}</span>
            {group.commands.map((c) => (
              <Button
                key={c.title}
                variant="ghost"
                size="icon"
                aria-label={c.title}
                title={c.disabled && c.hint ? c.hint : c.title}
                disabled={c.disabled}
                onClick={c.run}
              >
                {c.icon}
              </Button>
            ))}
            {group.content}
          </div>
        </div>
      ))}
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
  few: "Select 2 or more notes for a grid.",
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
 * uiStore for the session, and is kept within the count of the current selection.
 */
function GridControls({ notes, reason, onGrid }: { notes: Placed[]; reason: string | null; onGrid: (columns: number) => void }) {
  const chosen = useBoardUi((s) => s.gridColumns);
  const setColumns = useBoardUi((s) => s.setGridColumns);
  const hintId = useId();
  const count = notes.length;
  const auto = autoColumns(notes);
  const columns = chosen === null ? auto : Math.min(Math.max(1, chosen), count);
  return (
    <>
      <Button variant="ghost" title="Lay out in a grid" aria-describedby={reason ? hintId : undefined} disabled={reason !== null} onClick={() => onGrid(columns)}>
        <LayoutGrid />
        Grid
      </Button>
      <div role="group" aria-label="Columns" className="flex items-center">
        <span className="px-xs text-xs text-fg-muted">Columns</span>
        <Button variant="ghost" size="icon" aria-label="Fewer columns" title="Fewer columns" disabled={columns <= 1} onClick={() => setColumns(columns - 1)}>
          <Minus />
        </Button>
        <output data-grid-columns="" aria-live="polite" className="min-w-touch text-center text-sm tabular-nums">
          {chosen === null ? `Auto (${columns})` : columns}
        </output>
        <Button variant="ghost" size="icon" aria-label="More columns" title="More columns" disabled={columns >= count} onClick={() => setColumns(columns + 1)}>
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
      {reason && (
        <span id={hintId} className="px-xs text-xs text-fg-muted">
          {reason}
        </span>
      )}
    </>
  );
}

/**
 * Arrange commands for the selected notes (in selection order: the first is Match size's
 * reference). `apply` sends the changed rects; `order` restacks them; `notice` tells why a grid
 * didn't fit. Everything is off while disconnected; Grid also while a note in the selection is
 * held or unsaved.
 */
export function SelectionBar({
  notes,
  live,
  held,
  unsaved,
  apply,
  order,
  notice,
}: {
  notes: Placed[];
  live: boolean;
  held: boolean;
  unsaved: boolean;
  apply: (rects: (NoteRect & { id: string })[]) => void;
  order: (action: OrderAction) => void;
  notice: (text: string) => void;
}) {
  const send = (changes: Map<string, NoteRect>) => apply([...changes].map(([id, rect]) => ({ id, ...rect })));
  const canDistribute = notes.length >= 3;
  const gridReason = gridDisabledReason({ count: notes.length, live, held, unsaved });
  const runGrid = (columns: number) => {
    const result = grid(notes, columns, GRID_GAP);
    if (result.reason) notice(GRID_NO_ROOM[result.reason]);
    else send(result.changes);
  };
  return (
    <FloatingBar
      label="Selection"
      groups={[
        { label: "Align", commands: ALIGN.map((a) => ({ ...a, disabled: !live, run: () => send(align(notes, a.mode)) })) },
        {
          label: "Distribute",
          commands: DISTRIBUTE.map((d) => ({ ...d, disabled: !live || !canDistribute, ...(canDistribute ? {} : { hint: DISTRIBUTE_HINT }), run: () => send(distribute(notes, d.axis)) })),
        },
        { label: "Arrange", commands: [], content: <GridControls notes={notes} reason={gridReason} onGrid={runGrid} /> },
        { label: "Match size", commands: MATCH.map((m) => ({ ...m, disabled: !live, run: () => send(matchSize(notes, m.mode)) })) },
        { label: "Order", commands: ORDER_COMMANDS.map((c) => ({ title: c.label, icon: c.icon, disabled: !live, run: () => order(c.action) })) },
      ]}
    />
  );
}
