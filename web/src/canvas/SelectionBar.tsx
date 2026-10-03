import type { ReactNode } from "react";
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalDistributeCenter,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalDistributeCenter,
  MoveHorizontal,
  MoveVertical,
  Scaling,
} from "lucide-react";
import type { NoteRect } from "@stickyard/shared";
import { Button } from "../components/ui/button";
import { Panel } from "../components/ui/panel";
import { align, distribute, matchSize, type AlignMode, type Axis, type MatchMode, type Placed } from "./arrange";

/*
 * The floating bar at the top of the canvas for a multi-selection (md and up, Select tool), as
 * Chalkline's ArrangeBar: Align, Distribute (3+ notes) and Match size, each one button per mode.
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

/**
 * Arrange commands for the selected notes (in selection order: the first is Match size's
 * reference). `apply` sends the changed rects. Everything is off while disconnected.
 */
export function SelectionBar({ notes, live, apply }: { notes: Placed[]; live: boolean; apply: (rects: (NoteRect & { id: string })[]) => void }) {
  const send = (changes: Map<string, NoteRect>) => apply([...changes].map(([id, rect]) => ({ id, ...rect })));
  const canDistribute = notes.length >= 3;
  return (
    <FloatingBar
      label="Selection"
      groups={[
        { label: "Align", commands: ALIGN.map((a) => ({ ...a, disabled: !live, run: () => send(align(notes, a.mode)) })) },
        {
          label: "Distribute",
          commands: DISTRIBUTE.map((d) => ({ ...d, disabled: !live || !canDistribute, ...(canDistribute ? {} : { hint: DISTRIBUTE_HINT }), run: () => send(distribute(notes, d.axis)) })),
        },
        { label: "Match size", commands: MATCH.map((m) => ({ ...m, disabled: !live, run: () => send(matchSize(notes, m.mode)) })) },
      ]}
    />
  );
}
