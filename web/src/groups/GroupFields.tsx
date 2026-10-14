import { useId, useState, type KeyboardEvent } from "react";
import { GROUP_COLORS, MAX_GROUP_LABEL, MIN_GROUP_MEMBERS, type GroupColor } from "@stickyard/shared";
import { Ungroup as UngroupIcon, ListChecks, Minus, Plus } from "lucide-react";
import { Button } from "../components/ui/button";
import { Label } from "../components/ui/field";
import { Input } from "../components/ui/input";
import { Swatch, SwatchGroup } from "../notes/StyleFields";
import { FRAME_COLOR_NAMES } from "../frames/style";
import type { BoardGroup } from "./board";
import { GROUP_TEXT } from "./rules";
import { groupInk } from "./groupUi";

/*
 * One group's fields in the Properties panel (md and up, v0.38.0): Label (one line, at most 40
 * characters, committed on Enter or leaving the field), Colour (tints the box only; note colours
 * are untouched), "N members", Add selection, Remove selection, Select members and Ungroup. Off
 * buttons stay in place and say why (a guest on a locked board, a silent round, not connected,
 * or what the selection holds).
 */

export interface GroupFieldsProps {
  entry: BoardGroup;
  /** Why every control is off now (groups/rules.ts groupReason), or null. */
  reason: string | null;
  /** Selected notes and shapes (ids). */
  selected: readonly string[];
  onLabel: (label: string) => void;
  onColour: (color: GroupColor) => void;
  onAdd: (ids: string[]) => void;
  onRemove: (ids: string[]) => void;
  onSelectMembers: () => void;
  onUngroup: () => void;
}

export function GroupFields({ entry, reason, selected, onLabel, onColour, onAdd, onRemove, onSelectMembers, onUngroup }: GroupFieldsProps) {
  const id = useId();
  const { group } = entry;
  const [draft, setDraft] = useState<string | null>(null);
  const label = draft ?? group.label;
  const unsaved = entry.confirmed === null;
  const off = reason ?? (unsaved ? GROUP_TEXT.unsaved : null);
  const toAdd = selected.filter((m) => !group.members.includes(m));
  const toRemove = selected.filter((m) => group.members.includes(m));
  const addReason = off ?? (toAdd.length === 0 ? GROUP_TEXT.noneToAdd : null);
  const removeReason =
    off ?? (toRemove.length === 0 || toRemove.length === group.members.length ? GROUP_TEXT.noneToRemove : group.members.length - toRemove.length < MIN_GROUP_MEMBERS ? GROUP_TEXT.removeAll : null);
  const commit = () => {
    if (draft !== null && off === null) onLabel(draft);
    setDraft(null);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") setDraft(null);
  };
  const action = (key: string, text: string, icon: React.ReactNode, why: string | null, run: () => void) => (
    <div key={key} className="flex flex-col gap-2xs">
      <Button
        variant="ghost"
        aria-label={text}
        aria-disabled={why !== null || undefined}
        aria-describedby={why ? `${id}-${key}` : undefined}
        onClick={() => {
          if (why === null) run();
        }}
        className="self-start"
      >
        {icon}
        {text}
      </Button>
      {why && why !== off && (
        <p id={`${id}-${key}`} className="text-xs text-fg-muted">
          {why}
        </p>
      )}
    </div>
  );
  return (
    <div data-group-fields="" className="flex flex-col gap-md">
      {off && (
        <p data-group-reason="" id={`${id}-reason`} className="rounded-md bg-surface-muted p-ms text-sm">
          {off}
        </p>
      )}
      <div className="flex flex-col gap-xs">
        <Label htmlFor={`${id}-label`}>Label</Label>
        <Input
          id={`${id}-label`}
          value={label}
          maxLength={MAX_GROUP_LABEL}
          placeholder={GROUP_TEXT.untitled}
          readOnly={off !== null}
          aria-describedby={`${id}-hint`}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={commit}
        />
        <p id={`${id}-hint`} className="text-xs text-fg-muted">
          {GROUP_TEXT.labelHint}
        </p>
      </div>
      <SwatchGroup label="Colour" groupLabel="Group colour" current={FRAME_COLOR_NAMES[group.color]}>
        {GROUP_COLORS.map((c) => (
          <Swatch
            key={c}
            label={FRAME_COLOR_NAMES[c]}
            fill=""
            fillStyle={{ backgroundColor: "var(--sy-surface)", borderColor: groupInk(c), borderStyle: "dashed", borderWidth: "var(--sy-group-outline)" }}
            pressed={group.color === c}
            disabled={off !== null}
            onClick={() => onColour(c)}
          />
        ))}
      </SwatchGroup>
      <p data-group-members="" className="text-sm text-fg-muted tabular-nums">
        {GROUP_TEXT.members(group.members.length)}
      </p>
      <div className="flex flex-col gap-xs">
        {action("add", "Add selection", <Plus />, addReason, () => onAdd(toAdd))}
        {action("remove", "Remove selection", <Minus />, removeReason, () => onRemove(toRemove))}
        {action("select", "Select members", <ListChecks />, null, onSelectMembers)}
        {action("ungroup", "Ungroup", <UngroupIcon />, off, onUngroup)}
      </div>
    </div>
  );
}
