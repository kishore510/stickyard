import { NodeToolbar, Position } from "@xyflow/react";
import { useMemo } from "react";
import { readPxToken } from "../lib/cssVar";
import { EmojiPicker, type EmojiField } from "./EmojiPicker";

const TOOLBAR_STYLE = { zIndex: 5 } as const;

/**
 * The emoji button beside a note or shape whose text is edited in place (md and up): a React
 * Flow NodeToolbar to its right, screen-sized (44px at any zoom) and outside the item, so it
 * never covers the text, the resize handles, the vote badges (above) or the vote controls
 * (below). Its panel floats over the canvas.
 */
export function EmojiToolbar(props: {
  target: () => EmojiField | null;
  fits: (next: string) => boolean;
  onInsert: (value: string, caret: number) => void;
  disabled: boolean;
  onAway: (to: Element | null) => void;
}) {
  // The same gap as the vote controls below a note.
  const offset = useMemo(() => readPxToken("--sy-vote-controls-offset", 16), []);
  return (
    <NodeToolbar
      isVisible
      position={Position.Right}
      align="start"
      offset={offset}
      style={TOOLBAR_STYLE}
      data-emoji-toolbar=""
      className="nodrag nopan nowheel rounded-md border border-border bg-surface shadow-md"
    >
      <EmojiPicker label="Insert emoji" float {...props} />
    </NodeToolbar>
  );
}
