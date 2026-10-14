import { ViewportPortal, useStore } from "@xyflow/react";
import { memo, useEffect, useMemo, useRef, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { BOARD_HEIGHT, BOARD_WIDTH, MAX_GROUP_LABEL, NOTE_Z_LIMIT, type Group } from "@stickyard/shared";
import { readPxToken } from "../lib/cssVar";
import { isDrag } from "../canvas/geometry";
import type { Board } from "../notes/board";
import { useBoardUi } from "../canvas/uiStore";
import { chipText, groupBox, groupName, itemBoxes, labelMode, type Rect } from "./geometry";
import { GROUP_TEXT } from "./rules";
import { groupInk, useGroupUi } from "./groupUi";

/*
 * The group boxes on the canvas (protocol v22; v0.38.0). One layer in React Flow's viewport (board
 * units) between the frames and the arrows, so the order bottom to top is frame, group box, arrow,
 * note and shape. Each box is drawn from its members' live boxes plus the padding (nothing stored,
 * nothing sent when items move): a tinted dashed outline in the group's colour (the shapes' border
 * tokens, 3:1 on the board in both themes) with a label chip at its top-left. Inside the box,
 * presses go through to the items and the canvas; the chip and the outline select the group, and
 * dragging the chip moves every member with the existing batch moves. Text is only ever text.
 * Phones draw boxes and labels read-only.
 */

/** Group boxes sit between the frames (-NOTE_Z_LIMIT - 3) and the arrows (-NOTE_Z_LIMIT - 1). */
export const GROUP_Z_INDEX = -NOTE_Z_LIMIT - 2;

export interface GroupLayerActions {
  select(id: string): void;
  /** A chip press moved past the drag threshold: start moving the members (false: they can't move now). */
  startDrag(id: string): boolean;
  /** The members moved by (dx, dy) board units from where they started; `final` on release. */
  drag(dx: number, dy: number, final: boolean): void;
  startEdit(id: string): void;
  commitLabel(id: string, label: string): void;
}

/** Sizes from the tokens, read once (screen pixels). */
function useSizes() {
  return useMemo(() => ({ outline: readPxToken("--sy-group-outline", 2), hit: readPxToken("--sy-group-hit", 12), touch: readPxToken("--sy-touch-min", 44) }), []);
}

function LabelEditor({ group, onDone }: { group: Group; onDone: (label: string | null) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (label: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(label);
  };
  return (
    <input
      ref={ref}
      data-group-edit=""
      aria-label="Group label"
      maxLength={MAX_GROUP_LABEL}
      defaultValue={group.label}
      placeholder={GROUP_TEXT.untitled}
      className="sy-group-edit nopan nodrag nowheel"
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter" && !e.nativeEvent.isComposing) {
          e.preventDefault();
          finish(e.currentTarget.value);
        } else if (e.key === "Escape") {
          e.preventDefault();
          finish(null);
        }
      }}
      onBlur={(e) => finish(e.currentTarget.value)}
    />
  );
}

const GroupBox = memo(function GroupBox({
  group,
  box,
  zoom,
  selected,
  interactive,
  editable,
  editing,
  actions,
}: {
  group: Group;
  box: Rect;
  zoom: number;
  selected: boolean;
  interactive: boolean;
  editable: boolean;
  editing: boolean;
  actions: GroupLayerActions;
}) {
  const sizes = useSizes();
  const scale = zoom > 0 ? 1 / zoom : 1;
  const mode = labelMode(zoom);
  const text = chipText(group.label, mode);
  const ink = groupInk(group.color);
  const style: CSSProperties & Record<"--sy-group-ink", string> = {
    left: box.x,
    top: box.y,
    width: box.w,
    height: box.h,
    borderWidth: sizes.outline * scale,
    "--sy-group-ink": ink,
  };

  const pressChip = (e: ReactPointerEvent<HTMLElement>) => {
    if (!interactive || e.button !== 0) return;
    e.stopPropagation();
    const start = { x: e.clientX, y: e.clientY };
    const z = zoom > 0 ? zoom : 1;
    let moved = false;
    let started = false;
    const move = (m: PointerEvent) => {
      if (!moved && !isDrag(m.clientX - start.x, m.clientY - start.y, 4)) return;
      if (!moved) {
        moved = true;
        started = editable && actions.startDrag(group.id);
        if (started) useGroupUi.getState().setDragging(group.id);
      }
      if (started) actions.drag((m.clientX - start.x) / z, (m.clientY - start.y) / z, false);
    };
    const up = (u: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      if (started) {
        actions.drag((u.clientX - start.x) / z, (u.clientY - start.y) / z, true);
        useGroupUi.getState().setDragging(null);
      } else if (!moved) actions.select(group.id);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  const onKey = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if ((e.key === "Enter" && selected) || e.key === "F2") {
      if (!editable) return;
      e.preventDefault();
      e.stopPropagation();
      actions.startEdit(group.id);
    } else if (e.key === "Escape") {
      e.stopPropagation();
      useBoardUi.getState().clearSelection();
    }
  };

  const hit = (side: "top" | "right" | "bottom" | "left"): CSSProperties => {
    const t = sizes.hit * scale;
    const half = -t / 2;
    return side === "top"
      ? { left: half, right: half, top: half, height: t }
      : side === "bottom"
        ? { left: half, right: half, bottom: half, height: t }
        : side === "left"
          ? { top: half, bottom: half, left: half, width: t }
          : { top: half, bottom: half, right: half, width: t };
  };

  const chipStyle: CSSProperties = { transform: `translateY(-100%) scale(${scale})` };
  return (
    <div data-group-id={group.id} data-group-box="" data-color={group.color} className="sy-group-box" style={style}>
      {selected && <div data-group-selected="" aria-hidden="true" className="sy-group-selected" style={{ borderWidth: sizes.outline * 2 * scale }} />}
      {interactive &&
        (["top", "right", "bottom", "left"] as const).map((side) => (
          <div
            key={side}
            data-group-hit={side}
            aria-hidden="true"
            className="sy-group-hit nopan nodrag"
            style={hit(side)}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              e.stopPropagation();
            }}
            onClick={(e) => {
              e.stopPropagation();
              actions.select(group.id);
            }}
          />
        ))}
      <div className="sy-group-chip-slot" style={chipStyle}>
        {editing ? (
          <LabelEditor group={group} onDone={(label) => (label === null ? useBoardUi.getState().endGroupEdit() : actions.commitLabel(group.id, label))} />
        ) : interactive ? (
          <button
            type="button"
            data-group-chip=""
            data-mode={mode}
            tabIndex={0}
            aria-label={groupName(group)}
            aria-pressed={selected}
            title={editable ? `${groupName(group)}. Drag to move it, double-click to rename.` : groupName(group)}
            className="sy-group-chip nopan nodrag"
            onPointerDown={pressChip}
            onClick={(e) => {
              e.stopPropagation();
              // A keyboard press (Enter, Space) selects; a pointer press selected on release.
              if (e.detail === 0) actions.select(group.id);
            }}
            onDoubleClick={(e) => {
              e.stopPropagation();
              if (editable) actions.startEdit(group.id);
            }}
            onKeyDown={onKey}
          >
            {text}
          </button>
        ) : mode === "hidden" ? null : (
          <span data-group-chip="" data-mode={mode} className="sy-group-chip sy-group-chip-static">
            {text}
          </span>
        )}
      </div>
    </div>
  );
});

export const GroupLayer = memo(function GroupLayer({
  board,
  selected,
  interactive,
  editable,
  actions,
}: {
  board: Board;
  /** The group shown as selected (its chip pressed), or null. */
  selected: string | null;
  /** md and up: chips are buttons (select, drag, rename); phones draw boxes and labels read-only. */
  interactive: boolean;
  /** Group changes can be made now (connected, not locked out, no silent round). */
  editable: boolean;
  actions: GroupLayerActions;
}) {
  const zoom = useStore((s) => s.transform[2]);
  const editing = useBoardUi((s) => s.groupEdit?.id ?? null);
  const boxOf = useMemo(() => itemBoxes(board), [board]);
  return (
    <ViewportPortal>
      <div
        data-group-layer=""
        role="group"
        aria-label="Groups"
        className="sy-group-layer"
        style={{ zIndex: GROUP_Z_INDEX, width: BOARD_WIDTH, height: BOARD_HEIGHT }}
      >
        {board.groups.map(({ group }) => {
          const box = groupBox(group.members, boxOf);
          if (!box) return null;
          return (
            <GroupBox
              key={group.id}
              group={group}
              box={box}
              zoom={zoom}
              selected={selected === group.id}
              interactive={interactive}
              editable={editable}
              editing={interactive && editable && editing === group.id}
              actions={actions}
            />
          );
        })}
      </div>
    </ViewportPortal>
  );
});

/** Says my own group and ungroup politely (never anyone else's). Always in the page, so the live region is ready. */
export function GroupAnnouncer() {
  const announce = useGroupUi((s) => s.announce);
  return (
    <span data-group-announcer="" role="status" aria-live="polite" aria-atomic="true" className="sr-only">
      {announce?.text ?? ""}
    </span>
  );
}
