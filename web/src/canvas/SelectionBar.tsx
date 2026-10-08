import { useEffect, useId, useRef, useState, type ReactNode } from "react";
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
  ChevronDown,
  LayoutGrid,
  Lock,
  LockOpen,
  Minus,
  MoveHorizontal,
  MoveVertical,
  Plus,
  Redo2,
  Scaling,
  RotateCcw,
  SlidersHorizontal,
  Square,
  Trash2,
  Undo2,
  Vote,
  EyeOff,
} from "lucide-react";
import { clampFrameRect, type NoteRect, type OrderAction } from "@stickyard/shared";
import { Button } from "../components/ui/button";
import { Panel } from "../components/ui/panel";
import { ORDER_COMMANDS } from "../notes/OrderFields";
import { cn } from "../lib/utils";
import { GRID_GAP, align, autoColumns, distribute, grid, matchSize, mixedClamp, type AlignMode, type Axis, type GridReason, type MatchMode, type Placed } from "./arrange";
import { useBoardUi } from "./uiStore";
import { ARRANGE_HINTS, arrangeReason } from "./frameSelect";
import { LOCK_TEXT, lockToggle } from "../facilitation/lock";
import { useMediaQuery } from "../lib/useMediaQuery";
import { useRoomUi } from "../rooms/roomStore";
import { MEDIA } from "../styles/breakpoints";
import { useTimerControls } from "../timer/controls";
import { HostVotingControls } from "../voting/HostVoting";
import { HostSilentControls } from "../silent/HostSilent";
import { SILENT_UI } from "../silent/silent";

/*
 * The board actions bar (md and up). Since v0.15.1 it sits in the top bar, between the mark and
 * the menu (RoomBoard portals it into shell/topBarSlot.ts), in labelled groups: History (Undo,
 * Redo), Edit (Duplicate, Delete), Order (Bring to front, Send to back) and Arrange (one button
 * that opens Align, Distribute, Grid with its Columns stepper and Match size: Chalkline's
 * ArrangeBar). A command that doesn't apply now is off but never hidden: it stays focusable
 * (aria-disabled) and its tooltip, on hover and on keyboard focus, says why; when it's on, the
 * tooltip names it. History, Edit and Order show their names as text from xl up.
 */

export interface BarCommand {
  title: string;
  icon: ReactNode;
  disabled?: boolean;
  /** Why it's off: its tooltip while disabled (the title otherwise). */
  hint?: string;
  /** Shows the title as text next to the icon from xl up (it's always the accessible name). */
  text?: boolean;
  /** Shows the title as text at every width. */
  label?: boolean;
  /** Marks the host's lock toggle (data-lock-toggle). */
  lockToggle?: boolean;
  run: () => void;
}

export interface BarGroup {
  label: string;
  commands: BarCommand[];
  /** Arrange-style group: one button opens the commands and `content` in a panel under it. */
  collapsed?: { icon: ReactNode };
  /** Shown beside a collapsed group's button (a status that should stay in sight, e.g. "Locked"). */
  badge?: ReactNode;
  /** Controls of the group's own, after its commands. */
  content?: ReactNode;
}

/**
 * A bar button with its tooltip (role=tooltip, aria-describedby): shown on hover and on keyboard
 * focus, hidden by Escape or leaving. Off = aria-disabled: still focusable, the press does nothing.
 */
export function CommandButton({ command, className }: { command: BarCommand; className?: string }) {
  const tipId = useId();
  const [open, setOpen] = useState(false);
  const off = command.disabled === true;
  const tip = off && command.hint ? command.hint : command.title;
  return (
    <span className="relative inline-flex" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <Button
        variant="ghost"
        size={command.text || command.label ? "default" : "icon"}
        aria-label={command.title}
        aria-describedby={tipId}
        aria-disabled={off || undefined}
        data-lock-toggle={command.lockToggle ? "" : undefined}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && open) setOpen(false);
        }}
        onClick={(e) => {
          if (off) {
            e.preventDefault();
            return;
          }
          command.run();
        }}
        className={cn((command.text || command.label) && "min-w-touch px-sm", className)}
      >
        {command.icon}
        {command.label ? <span>{command.title}</span> : command.text && <span className="hidden xl:inline">{command.title}</span>}
      </Button>
      <span
        role="tooltip"
        id={tipId}
        hidden={!open}
        className="pointer-events-none absolute top-full left-1/2 z-50 mt-xs -translate-x-1/2 rounded-md border border-border bg-surface px-sm py-xs text-xs font-normal whitespace-nowrap text-fg shadow-md"
      >
        {tip}
      </span>
    </span>
  );
}

/**
 * A collapsed group: one button (aria-expanded) that opens a panel under it with the group's
 * commands and controls. Escape (focus back on the button), a second press or a press outside
 * closes it. The panel stays in the page while closed (hidden), so its controls keep their state.
 */
function CollapsedGroup({ group }: { group: BarGroup }) {
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (e.target instanceof Node && !root.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);
  return (
    <div ref={root} className="relative flex items-center">
      <Button
        ref={toggle}
        variant="ghost"
        aria-label={group.label}
        title={group.label}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
        className={cn("min-w-touch px-sm", open && "bg-surface-muted")}
      >
        {group.collapsed?.icon}
        <span className="hidden xl:inline">{group.label}</span>
        <ChevronDown />
      </Button>
      <Panel
        id={panelId}
        role="group"
        aria-label={group.label}
        hidden={!open}
        onKeyDown={(e) => {
          if (e.key !== "Escape" || e.defaultPrevented) return;
          e.preventDefault();
          setOpen(false);
          toggle.current?.focus();
        }}
        className="absolute top-full right-0 z-50 mt-xs flex w-max max-w-arrange flex-wrap items-center gap-2xs p-xs shadow-lg"
      >
        {group.commands.map((c) => (
          <CommandButton key={c.title} command={c} />
        ))}
        {group.content}
      </Panel>
    </div>
  );
}

/** One group: its commands in a row, or (collapsed) one button that opens them. */
function BarGroupView({ group, first }: { group: BarGroup; first: boolean }) {
  return (
    <div className="flex shrink-0 items-center">
      {!first && <div aria-hidden="true" className="mx-xs h-icon-lg w-px bg-border" />}
      {group.collapsed ? (
        <>
          <CollapsedGroup group={group} />
          {group.badge}
        </>
      ) : (
        <div role="group" aria-label={group.label} className="flex items-center gap-2xs">
          {group.commands.map((c) => (
            <CommandButton key={c.title} command={c} />
          ))}
          {group.content}
        </div>
      )}
    </div>
  );
}

/** A toolbar of labelled groups with dividers between them, in one row. `data-board-bar`: keys pressed here still act on the board. */
export function FloatingBar({ label, groups }: { label: string; groups: BarGroup[] }) {
  return (
    <div role="toolbar" aria-label={label} data-board-bar="" className="flex min-w-0 items-center">
      {groups.map((group, i) => (
        <BarGroupView key={group.label} group={group} first={i === 0} />
      ))}
    </div>
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

export const DISTRIBUTE_HINT = "Select 3 or more notes or shapes to distribute.";

/** Why Grid is off, shown next to it. */
export const GRID_HINTS = {
  few: "Select 2 or more notes or shapes to arrange.",
  offline: "Not connected.",
  held: "Finish moving or resizing first.",
  unsaved: "Wait until new notes and shapes are saved.",
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
 * uiStore for the session, and is kept within the count of the current selection. Grid explains
 * why it's off in its tooltip.
 */
function GridControls({ notes, reason, onGrid }: { notes: Placed[]; reason: string | null; onGrid: (columns: number) => void }) {
  const chosen = useBoardUi((s) => s.gridColumns);
  const setColumns = useBoardUi((s) => s.setGridColumns);
  const count = Math.max(1, notes.length);
  const auto = notes.length > 0 ? autoColumns(notes) : 1;
  const columns = chosen === null ? auto : Math.min(Math.max(1, chosen), count);
  return (
    <>
      <CommandButton
        command={{ title: "Grid", icon: <LayoutGrid />, label: true, disabled: reason !== null, ...(reason ? { hint: reason } : {}), run: () => onGrid(columns) }}
      />
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
    </>
  );
}

/** Why Order is off: frames always sit behind notes, so only notes restack. */
export const ORDER_HINTS = {
  none: "Select notes or shapes to restack them.",
  frame: "Frames always sit behind notes.",
  offline: "Not connected.",
} as const;

/** Why Delete is off. */
export const DELETE_HINTS = {
  none: "Select notes, shapes or a frame first.",
  offline: "Not connected.",
} as const;

export interface BoardBarProps {
  /** Selected notes, in selection order (the first is Match size's reference). */
  notes: Placed[];
  /** Selected frames, in selection order (v0.20.0): arranged like notes when they're all that's selected. */
  frames?: Placed[];
  /** A selected frame is being moved or resized here, or has no server id yet. */
  framesHeld?: boolean;
  framesUnsaved?: boolean;
  /** Sends arranged frame rects (frames carry their notes when they move). */
  applyFrames?: (rects: (NoteRect & { id: string })[]) => void;
  /** A frame is selected (instead of notes). */
  frame: boolean;
  /** Selected shapes (protocol v15), in selection order: they delete, restack and arrange with notes. */
  shapes?: Placed[];
  /** A selected shape is being moved or resized here, or has no server id yet. */
  shapesHeld?: boolean;
  shapesUnsaved?: boolean;
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
  /** A guest on a locked board: every command is off with this reason (null: not locked out). */
  lockedReason?: string | null;
  /** A silent round is running: frames can't move (Align, Distribute, Grid on frames; Match size still works). */
  silentReason?: string | null;
  /** The host's Session group (Lock / Unlock); null for guests, who get no dead buttons. */
  session?: { locked: boolean; pending: boolean | null; setLock: (locked: boolean) => boolean } | null;
}

/**
 * The bar's groups for the current selection. Edit: Duplicate and Delete. Order: Bring to front
 * and Send to back for notes. Arrange (2+ notes; Distribute 3+): `apply` sends the changed rects;
 * `notice` tells why a grid didn't fit. Everything is off while disconnected; Grid also while a
 * note in the selection is held or unsaved.
 */
export function BoardBar({
  notes,
  frames = [],
  framesHeld = false,
  framesUnsaved = false,
  applyFrames = () => {},
  frame,
  shapes = [],
  shapesHeld = false,
  shapesUnsaved = false,
  live,
  held,
  unsaved,
  duplicateReason,
  duplicate,
  undoReason,
  redoReason,
  undo,
  redo,
  remove,
  apply,
  order,
  notice,
  lockedReason = null,
  silentReason = null,
  session = null,
}: BoardBarProps) {
  // Arrange works on notes and shapes together (protocol v15; each clamped to its own limits), or
  // (v0.20.0) on the frames when only frames are selected; a mix with frames is refused with a reason.
  const onFrames = frames.length > 0;
  const stacked = [...notes, ...shapes];
  const mixed = onFrames && stacked.length > 0;
  const items = onFrames ? frames : stacked;
  const clamp = onFrames ? clampFrameRect : shapes.length > 0 ? mixedClamp(new Set(shapes.map((x) => x.id))) : undefined;
  const send = (changes: Map<string, NoteRect>) => (onFrames ? applyFrames : apply)([...changes].map(([id, rect]) => ({ id, ...rect })));
  const count = stacked.length;
  const frameReason = onFrames ? arrangeReason({ notes: stacked.length, frames: frames.length, live, locked: lockedReason, held: framesHeld, unsaved: framesUnsaved }) : null;
  // Frames can't move during a silent round (the relay refuses frameMove); their size can change.
  const frameMoveReason = onFrames && !mixed ? silentReason : null;
  const gridReason = onFrames ? (frameReason ?? frameMoveReason) : (lockedReason ?? gridDisabledReason({ count, live, held: held || shapesHeld, unsaved: unsaved || shapesUnsaved }));
  const runGrid = (columns: number) => {
    const result = grid(items, columns, GRID_GAP, clamp);
    if (result.reason) notice(GRID_NO_ROOM[result.reason]);
    else send(result.changes);
  };
  const stackable = count;
  const deleteReason = lockedReason ?? (stackable === 0 && !frame ? DELETE_HINTS.none : !live ? DELETE_HINTS.offline : null);
  const orderReason = lockedReason ?? (stackable === 0 ? (frame ? ORDER_HINTS.frame : ORDER_HINTS.none) : !live ? ORDER_HINTS.offline : null);
  // Align and Match size need 2+ notes (or frames) and a connection; Distribute needs 3.
  const arrangeOff = onFrames ? frameReason : (lockedReason ?? (count < 2 ? GRID_HINTS.few : !live ? GRID_HINTS.offline : null));
  const off = (reason: string | null) => ({ disabled: reason !== null, ...(reason ? { hint: reason } : {}) });
  const toggle = session ? lockToggle({ locked: session.locked, pending: session.pending, live }) : null;
  // From xl up every group is in full; below, Order and the host's Session fold into panels (with
  // the timer chip and the avatars, the top bar would overflow otherwise).
  const full = useMediaQuery(MEDIA.wideDesktop);
  const timer = useTimerControls();
  const timerRunning = useRoomUi((s) => s.room?.timer !== null && s.room?.timer !== undefined);
  const orderCommands: BarCommand[] = ORDER_COMMANDS.map((c) => ({ title: c.label, icon: c.icon, ...off(orderReason), run: () => order(c.action) }));
  const lockedMarker = session?.locked ? (
    <span data-locked-indicator="" className="ml-xs rounded-full border border-border bg-surface-muted px-sm text-xs font-semibold">
      {LOCK_TEXT.locked}
    </span>
  ) : null;
  const moveOff = arrangeOff ?? frameMoveReason;
  const distributeReason = moveOff ?? (items.length < 3 ? (onFrames ? ARRANGE_HINTS.fewFramesDistribute : DISTRIBUTE_HINT) : null);
  return (
    <FloatingBar
      label="Board actions"
      groups={[
        {
          label: "History",
          commands: [
            { title: "Undo", icon: <Undo2 />, ...off(undoReason), run: undo },
            { title: "Redo", icon: <Redo2 />, ...off(redoReason), run: redo },
          ],
        },
        {
          label: "Edit",
          commands: [
            { title: "Duplicate", icon: <Copy />, ...off(duplicateReason), run: duplicate },
            { title: "Delete", icon: <Trash2 />, ...off(deleteReason), run: remove },
          ],
        },
        ...(full ? [{ label: "Order", commands: orderCommands }] : []),
        {
          label: "Arrange",
          collapsed: { icon: <SlidersHorizontal /> },
          commands: [
            // Below xl, Order folds in here so the top bar keeps one row.
            ...(full ? [] : orderCommands),
            ...ALIGN.map((a) => ({ ...a, ...off(moveOff), run: () => send(align(items, a.mode, clamp)) })),
            ...DISTRIBUTE.map((d) => ({ ...d, ...off(distributeReason), run: () => send(distribute(items, d.axis, clamp)) })),
            ...MATCH.map((m) => ({ ...m, ...off(arrangeOff), run: () => send(matchSize(items, m.mode, clamp)) })),
          ],
          content: (
            <>
              {/* A mix of notes and frames: the reason as text in the panel, not only in tooltips. */}
              {(mixed || (frameMoveReason && arrangeOff === null)) && (
                <p data-arrange-reason="" className="w-full px-xs pb-xs text-sm text-fg-muted">
                  {mixed ? ARRANGE_HINTS.mixed : frameMoveReason}
                </p>
              )}
              <GridControls notes={items} reason={gridReason} onGrid={runGrid} />
            </>
          ),
        },
        ...(session && toggle
          ? [
              {
                label: "Session",
                // Below xl, one button that opens the lock (and the timer's Restart and Stop, which
                // are on the timer chip from xl up); the Locked marker stays beside it.
                ...(full ? {} : { collapsed: { icon: session.locked ? <Lock /> : <LockOpen /> }, badge: lockedMarker }),
                commands: [
                  {
                    title: toggle.label,
                    icon: session.locked ? <LockOpen /> : <Lock />,
                    label: true,
                    lockToggle: true,
                    ...off(toggle.reason),
                    run: () => void session.setLock(!session.locked),
                  },
                  ...(!full && timerRunning
                    ? [
                        { title: "Restart timer", icon: <RotateCcw />, label: true, ...off(timer.reason), run: () => void timer.restart() },
                        { title: "Stop timer", icon: <Square />, label: true, ...off(timer.reason), run: () => void timer.stop() },
                      ]
                    : []),
                ],
                // Dot voting (v0.18.0): its own button and panel inside the Session group from xl
                // up; below, in the Session panel under the lock.
                content: full ? (
                  <>
                    {lockedMarker}
                    <CollapsedGroup group={{ label: "Voting", collapsed: { icon: <Vote /> }, commands: [], content: <HostVotingControls className="p-xs" /> }} />
                    <CollapsedGroup
                      group={{ label: SILENT_UI.heading, collapsed: { icon: <EyeOff /> }, commands: [], content: <HostSilentControls className="p-xs" /> }}
                    />
                  </>
                ) : (
                  <>
                    <HostVotingControls className="w-full border-t border-border p-xs pt-sm" />
                    <HostSilentControls className="w-full border-t border-border p-xs pt-sm" />
                  </>
                ),
              },
            ]
          : []),
      ]}
    />
  );
}
