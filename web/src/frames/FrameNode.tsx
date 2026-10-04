import { createContext, memo, useContext, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { NodeResizer, type NodeProps } from "@xyflow/react";
import { GripHorizontal } from "lucide-react";
import { FRAME_MAX_H, FRAME_MAX_W, FRAME_MIN_H, FRAME_MIN_W, MAX_FRAME_TITLE, type NoteRect } from "@stickyard/shared";
import type { FrameFlowNode } from "../canvas/nodes";
import { useBoardUi } from "../canvas/uiStore";
import { isLocalId } from "../notes/board";
import { cn } from "../lib/utils";
import { frameHeaderStyle, frameRootStyle, frameTitleClasses } from "./style";

export interface FrameActions {
  /** Selects just this frame (clears the note selection). */
  selectFrame(id: string): void;
  /** The title being typed (a draft: no messages until it's committed). */
  setDraft(id: string, draft: string): void;
  /** Saves the draft, if there is one (Enter, Esc, or leaving the field). */
  commitTitle(id: string): void;
  startResize(id: string): boolean;
  resize(id: string, rect: NoteRect, final: boolean): void;
}

/** Stable for the life of the board, so frames don't re-render for it. */
export const FrameActionsContext = createContext<FrameActions | null>(null);

const rectOf = (p: { x: number; y: number; width: number; height: number }): NoteRect => ({ x: p.x, y: p.y, w: p.width, h: p.height });

/** Strips along the frame's sides and bottom that drag it (the title bar is the top). */
const EDGES = [
  "top-frame-header bottom-0 left-0 w-frame-edge",
  "top-frame-header right-0 bottom-0 w-frame-edge",
  "right-0 bottom-0 left-0 h-frame-edge",
] as const;

/**
 * One frame (protocol v9): a named, coloured area behind the notes. Its body lets every pointer
 * through (React Flow gives the node no pointer events; see nodes.ts), so clicks, marquees and
 * pans start on the canvas and notes inside stay usable. The title bar and the border take
 * presses: a click selects the frame, a drag moves it (with the notes inside, unless Alt is held).
 * The title is a plain one-line field in the header, a draft until Enter, Esc or leaving it,
 * in the frame's title style (v10); the header's height follows the title size (tokens), and
 * the side strips start below it. Phones show the frame and its styled title only. The title is untrusted text, rendered as text.
 */
export const FrameNode = memo(function FrameNode({ id, data }: NodeProps<FrameFlowNode>) {
  const actions = useContext(FrameActionsContext);
  const { entry, editable, selected, resizable } = data;
  const { frame } = entry;
  const input = useRef<HTMLInputElement>(null);
  const request = useBoardUi((s) => (s.frameEditRequest?.id === id ? s.frameEditRequest : null));

  // A new frame (or an edit request) puts the caret at the end of the title. A new frame's node is
  // replaced when its server id arrives, so the request stays until the confirmed node has focus.
  useEffect(() => {
    const el = input.current;
    if (!request || !editable || !el) return;
    if (document.activeElement !== el) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
    if (!isLocalId(id)) useBoardUi.setState({ frameEditRequest: null });
  }, [request, editable, id]);

  // The title takes presses only while it's being edited: a click on it selects the frame (so
  // Delete deletes it) and drags with the header; double-click (or Enter, or Tab) edits it.
  const [titleFocused, setTitleFocused] = useState(false);
  const select = () => {
    if (editable) actions?.selectFrame(id);
  };
  const editTitle = () => {
    const el = input.current;
    if (!editable || !el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (e.nativeEvent.isComposing || (e.key !== "Enter" && e.key !== "Escape")) return;
    e.preventDefault();
    actions?.commitTitle(id);
    e.currentTarget.blur();
  };
  const handle = editable ? "sy-frame-handle pointer-events-auto cursor-grab" : "";

  return (
    <>
      <NodeResizer
        isVisible={resizable}
        minWidth={FRAME_MIN_W}
        minHeight={FRAME_MIN_H}
        maxWidth={FRAME_MAX_W}
        maxHeight={FRAME_MAX_H}
        handleClassName="sy-resize-handle sy-frame-resize"
        lineClassName="sy-resize-line sy-frame-resize"
        onResizeStart={() => actions?.startResize(id)}
        onResize={(_, p) => actions?.resize(id, rectOf(p), false)}
        onResizeEnd={(_, p) => actions?.resize(id, rectOf(p), true)}
      />
      <div
        role="group"
        aria-label={`Frame: ${frame.title || "untitled"}`}
        data-frame-id={id}
        aria-current={selected || undefined}
        className={cn(
          "relative size-full rounded-lg border-2",
          entry.confirmed === null && "border-dashed opacity-75",
          selected && "sy-selected",
        )}
        style={frameRootStyle(frame)}
      >
        <div
          data-frame-handle="header"
          className={cn("flex h-frame-header items-center gap-xs rounded-t-md px-sm", handle)}
          style={frameHeaderStyle(frame)}
          onClick={select}
          onDoubleClick={editTitle}
        >
          {editable && <GripHorizontal aria-hidden="true" className="size-icon-sm shrink-0 opacity-60" />}
          {editable ? (
            <input
              ref={input}
              data-frame-title
              aria-label="Frame title"
              placeholder="Frame title"
              autoComplete="off"
              maxLength={MAX_FRAME_TITLE * 2}
              value={entry.draft ?? frame.title}
              data-editing={titleFocused || undefined}
              onFocus={() => {
                setTitleFocused(true);
                select();
              }}
              onChange={(e) => actions?.setDraft(id, e.target.value)}
              onKeyDown={onKeyDown}
              onBlur={() => {
                setTitleFocused(false);
                actions?.commitTitle(id);
              }}
              className={cn(
                "nodrag nopan min-w-0 flex-1 cursor-text rounded-sm bg-transparent text-inherit placeholder:text-inherit placeholder:opacity-60",
                !titleFocused && "pointer-events-none",
                frameTitleClasses(frame),
              )}
            />
          ) : (
            <span data-frame-title className={cn("min-w-0 flex-1 truncate", frameTitleClasses(frame))}>
              {frame.title}
            </span>
          )}
        </div>
        {editable && EDGES.map((edge) => <div key={edge} aria-hidden="true" data-frame-handle="edge" className={cn("absolute", edge, handle)} onClick={select} />)}
      </div>
    </>
  );
});
