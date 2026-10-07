import { createContext, memo, useContext, useEffect, useLayoutEffect, useRef, type ClipboardEvent, type KeyboardEvent, type PointerEvent } from "react";
import { NodeResizer, type NodeProps } from "@xyflow/react";
import { Check } from "lucide-react";
import {
  MAX_SHAPE_TEXT,
  SHAPE_MAX_H,
  SHAPE_MAX_W,
  SHAPE_MIN_H,
  SHAPE_MIN_W,
  cleanShapeText,
  codePointLength,
  truncateCodePoints,
  type NoteRect,
  type Shape,
} from "@stickyard/shared";
import type { ShapeFlowNode } from "../canvas/nodes";
import { noteClick } from "../canvas/pointer";
import { useBoardUi } from "../canvas/uiStore";
import { cn } from "../lib/utils";
import { KEY_STEP, KEY_STEP_BIG, NoteHelpContext } from "../notes/NoteCard";
import { keyResize, type SizeLimits } from "../notes/size";
import { isShapeHeld, type BoardShape } from "./board";
import { SHAPE_PLACEHOLDER, shapeLabel } from "./label";
import { shapeOutlineStyle, shapeTextBoxStyle, shapeTextStyle, shapeValignStyle } from "./style";

/** After the last arrow key press, the position (or size) is committed (stored) this much later. */
const KEY_COMMIT_MS = 400;
export const SHAPE_LIMITS: SizeLimits = { minW: SHAPE_MIN_W, minH: SHAPE_MIN_H, maxW: SHAPE_MAX_W, maxH: SHAPE_MAX_H };

export interface ShapeActions {
  /** Selects just this shape (a click, keyboard focus). */
  select(id: string): void;
  /** Shift/Ctrl/Cmd-click: adds it to the selection or takes it out (md and up). */
  toggle(id: string): void;
  /** Starts editing its text in place (double-click, Enter). */
  startEdit(id: string): void;
  setDraft(id: string, text: string): void;
  /** Ends editing in place, saving the draft if it changed. */
  commit(id: string): void;
  startResize(id: string): boolean;
  resize(id: string, rect: NoteRect, final: boolean): void;
  /** Arrow keys: a move (live, then final a moment after the last press). */
  move(id: string, x: number, y: number, final: boolean): void;
  /** Arrow keys on a shape that's one of several selected: moves the whole selection. False if it isn't. */
  moveSelection(id: string, dx: number, dy: number): boolean;
  /** The Delete key: the shape, or the selection when it's one of several (asks first). */
  remove(id: string): void;
  reveal(id: string): void;
  clearSelection(): void;
}

/** Stable for the life of the board, so shapes don't re-render for it. */
export const ShapeActionsContext = createContext<ShapeActions | null>(null);

/**
 * The outline, drawn as inline SVG so the border width and dashes are the style's: stretched to
 * the node (preserveAspectRatio none) with a non-scaling stroke, so a thin border stays thin at
 * any size. A text label draws nothing unless it's given a fill or border.
 */
function Outline({ shape }: { shape: Shape }) {
  const style = shapeOutlineStyle(shape);
  const common = { style, vectorEffect: "non-scaling-stroke" as const };
  return (
    <svg aria-hidden="true" viewBox="0 0 100 100" preserveAspectRatio="none" className="pointer-events-none absolute inset-0 size-full overflow-visible">
      {shape.kind === "oval" ? (
        <ellipse cx="50" cy="50" rx="50" ry="50" {...common} />
      ) : shape.kind === "diamond" ? (
        <polygon points="50,0 100,50 50,100 0,50" {...common} />
      ) : (
        <rect x="0" y="0" width="100" height="100" {...common} />
      )}
    </svg>
  );
}

/**
 * The shape's text edited in place (md and up): one plain textarea, never contenteditable, styled
 * like the shape's text. What's typed is the shape's draft (remote edits never replace it) until
 * Escape or focus leaving commits it. Enter is a new line. Input stops at MAX_SHAPE_TEXT
 * characters; paste is cleaned plain text cut to what fits.
 */
function ShapeTextEditor({
  shape,
  text,
  request,
  readOnly,
  onDraft,
  onCommit,
}: {
  shape: Shape;
  text: string;
  request: number;
  readOnly: boolean;
  onDraft: (text: string) => void;
  onCommit: (refocus: boolean) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const caret = useRef<number | null>(null);
  useEffect(() => {
    const el = ref.current;
    el?.focus();
    el?.setSelectionRange(el.value.length, el.value.length);
  }, [request]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
    if (caret.current !== null) {
      el.setSelectionRange(caret.current, caret.current);
      caret.current = null;
    }
  });
  const paste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    e.preventDefault();
    const el = e.currentTarget;
    const before = el.value.slice(0, el.selectionStart);
    const after = el.value.slice(el.selectionEnd);
    const room = MAX_SHAPE_TEXT - codePointLength(before) - codePointLength(after);
    const cleaned = cleanShapeText(truncateCodePoints(e.clipboardData.getData("text/plain"), MAX_SHAPE_TEXT)) ?? "";
    const insert = truncateCodePoints(cleaned, Math.max(0, room));
    caret.current = before.length + insert.length;
    onDraft(before + insert + after);
  };
  return (
    <textarea
      ref={ref}
      data-shape-input=""
      aria-label="Shape text"
      rows={1}
      value={text}
      readOnly={readOnly}
      aria-readonly={readOnly || undefined}
      placeholder={SHAPE_PLACEHOLDER}
      spellCheck
      onChange={(e) => {
        // Over the cap: refused, so the field keeps what it had.
        if (codePointLength(e.target.value) <= MAX_SHAPE_TEXT) onDraft(e.target.value);
      }}
      onPaste={paste}
      onKeyDown={(e) => {
        // The text's keys: never the shape's, the board's or React Flow's.
        e.stopPropagation();
        if (e.key === "Escape" && !e.nativeEvent.isComposing) {
          e.preventDefault();
          onCommit(true);
        }
      }}
      onBlur={() => onCommit(false)}
      style={shapeTextStyle(shape)}
      className="nodrag nopan nowheel block w-full resize-none overflow-hidden border-0 bg-transparent p-0 break-words whitespace-pre-wrap outline-none placeholder:text-fg-muted"
    />
  );
}

/**
 * One shape on the board (protocol v15): a text label, rectangle, oval or diamond. Its text is
 * untrusted and only ever rendered as React text. A click or keyboard focus selects it;
 * double-click or Enter edits its text in place; arrow keys move it, Alt+arrow keys resize it
 * (Shift for bigger steps); Delete deletes it. Phones show shapes read-only.
 */
export function ShapeCard({ entry, editable, selected }: { entry: BoardShape; editable: boolean; selected: boolean }) {
  const actions = useContext(ShapeActionsContext);
  const describedBy = useContext(NoteHelpContext);
  const { shape } = entry;
  const pending = entry.confirmed === null;
  const editRequest = useBoardUi((s) => (s.shapeEdit?.id === shape.id ? s.shapeEdit : null));
  const editing = editRequest !== null && !isShapeHeld(entry);
  // Alt+arrow resizes one shape at a time (several resize through Match size).
  const several = useBoardUi((s) => s.selection.size + s.frames.size + s.shapes.size > 1);
  const cardRef = useRef<HTMLDivElement>(null);
  const pressing = useRef(false);
  const keyCommit = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef(shape);
  latest.current = shape;
  useEffect(() => () => clearTimeout(keyCommit.current), []);
  if (!actions) return null;
  const text = entry.draft ?? shape.text;
  // A text label with nothing to show is outlined faintly with a placeholder, so it can be found.
  const bare = shape.fill === "none" && shape.strokeWidth === "none";
  const empty = text.trim() === "";

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Escape" && selected) {
      e.preventDefault();
      actions.clearSelection();
      return;
    }
    if (!editable) return;
    const step = e.shiftKey ? KEY_STEP_BIG : KEY_STEP;
    const delta: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const move = delta[e.key];
    if (move && e.altKey) {
      e.preventDefault();
      if (several) return;
      const rect = keyResize(shape, e.key, e.shiftKey, SHAPE_LIMITS);
      if (pending || !rect || !actions.startResize(shape.id)) return;
      actions.resize(shape.id, rect, false);
      clearTimeout(keyCommit.current);
      keyCommit.current = setTimeout(() => actions.resize(shape.id, latest.current, true), KEY_COMMIT_MS);
      return;
    }
    if (move) {
      e.preventDefault();
      if (actions.moveSelection(shape.id, move[0], move[1])) return;
      if (pending) return;
      actions.move(shape.id, shape.x + move[0], shape.y + move[1], false);
      actions.reveal(shape.id);
      clearTimeout(keyCommit.current);
      keyCommit.current = setTimeout(() => actions.move(shape.id, latest.current.x, latest.current.y, true), KEY_COMMIT_MS);
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      actions.startEdit(shape.id);
      return;
    }
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      actions.remove(shape.id);
    }
  };

  return (
    <div
      ref={cardRef}
      role={editing ? "group" : "button"}
      tabIndex={0}
      aria-roledescription="shape"
      aria-label={shapeLabel({ kind: shape.kind, text })}
      aria-describedby={describedBy}
      aria-disabled={!editable || undefined}
      aria-busy={pending || undefined}
      aria-current={selected || undefined}
      data-shape-id={shape.id}
      data-shape-kind={shape.kind}
      data-shape-empty={(bare && empty) || undefined}
      data-editing={editing || undefined}
      onPointerDown={(e: PointerEvent<HTMLDivElement>) => {
        pressing.current = e.button === 0 || e.pointerType !== "mouse";
      }}
      onClick={(e) => {
        pressing.current = false;
        if (editing) return;
        if (noteClick(e) === "toggle") return actions.toggle(shape.id);
        actions.select(shape.id);
      }}
      onDoubleClick={() => {
        if (editable && !editing) actions.startEdit(shape.id);
      }}
      onFocus={(e) => {
        if (e.target !== e.currentTarget) return;
        // A press decides the selection with its click; keyboard focus selects.
        if (pressing.current) {
          pressing.current = false;
          return;
        }
        actions.select(shape.id);
      }}
      onKeyDown={onKeyDown}
      className={cn(
        "relative size-full touch-none select-none",
        editable ? "cursor-grab" : "cursor-default",
        entry.dragging && "cursor-grabbing",
        pending && "opacity-75",
        bare && empty && !editing && "sy-shape-empty",
        selected && "sy-selected",
        editing && "nodrag cursor-text ring-4 ring-focus ring-offset-2 ring-offset-board",
      )}
    >
      <Outline shape={shape} />
      <div data-shape-text="" style={{ ...shapeTextBoxStyle(shape.kind), ...shapeValignStyle(shape.valign) }} className="overflow-hidden">
        {editing ? (
          <ShapeTextEditor
            shape={shape}
            text={text}
            request={editRequest.n}
            readOnly={!editable}
            onDraft={(t) => actions.setDraft(shape.id, t)}
            onCommit={(refocus) => {
              actions.commit(shape.id);
              if (refocus) cardRef.current?.focus();
            }}
          />
        ) : empty ? (
          bare && (
            <p aria-hidden="true" data-shape-placeholder="" style={shapeTextStyle(shape)} className="sy-shape-placeholder">
              {SHAPE_PLACEHOLDER}
            </p>
          )
        ) : (
          <p aria-hidden="true" style={shapeTextStyle(shape)} className="min-h-0 break-words whitespace-pre-wrap">
            {text}
          </p>
        )}
      </div>
    </div>
  );
}

const rectOf = (p: { x: number; y: number; width: number; height: number }): NoteRect => ({ x: p.x, y: p.y, w: p.width, h: p.height });

/** The React Flow node for a shape. Memoised: it re-renders only when its own entry changes. */
export const ShapeNode = memo(function ShapeNode({ id, data }: NodeProps<ShapeFlowNode>) {
  const actions = useContext(ShapeActionsContext);
  const several = useBoardUi((s) => s.selection.size + s.frames.size + s.shapes.size > 1);
  return (
    <>
      <NodeResizer
        isVisible={data.resizable}
        minWidth={SHAPE_MIN_W}
        minHeight={SHAPE_MIN_H}
        maxWidth={SHAPE_MAX_W}
        maxHeight={SHAPE_MAX_H}
        handleClassName="sy-resize-handle"
        lineClassName="sy-resize-line"
        onResizeStart={() => actions?.startResize(id)}
        onResize={(_, p) => actions?.resize(id, rectOf(p), false)}
        onResizeEnd={(_, p) => actions?.resize(id, rectOf(p), true)}
      />
      <ShapeCard entry={data.entry} editable={data.editable} selected={data.selected} />
      {data.selected && several && (
        <span data-select-badge aria-hidden="true" className="sy-select-badge">
          <Check strokeWidth={3} />
        </span>
      )}
    </>
  );
});
