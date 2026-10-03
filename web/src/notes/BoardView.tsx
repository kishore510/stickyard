import { useId, useRef, type PointerEvent, type RefObject } from "react";
import type { Board } from "./board";
import { NoteCard, type NoteActions } from "./NoteCard";

/**
 * The board: a fixed-size surface (BOARD_WIDTH x BOARD_HEIGHT board units, 1 unit = 1px) in a
 * scrolling window. Touch pans natively (notes themselves don't scroll the page, so they can
 * be dragged); a mouse pans by dragging empty space; wheels and trackpads scroll.
 * No zoom yet.
 */
export function BoardView({
  board,
  editable,
  viewportRef,
  actions,
}: {
  board: Board;
  editable: boolean;
  viewportRef: RefObject<HTMLDivElement | null>;
  actions: NoteActions;
}) {
  const instructionsId = useId();
  const pan = useRef<{ pointer: number; x: number; y: number; left: number; top: number } | null>(null);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    const viewport = viewportRef.current;
    if (e.pointerType !== "mouse" || e.button !== 0 || e.target !== e.currentTarget || !viewport) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    pan.current = {
      pointer: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      left: viewport.scrollLeft,
      top: viewport.scrollTop,
    };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const p = pan.current;
    const viewport = viewportRef.current;
    if (!p || p.pointer !== e.pointerId || !viewport) return;
    viewport.scrollLeft = p.left - (e.clientX - p.x);
    viewport.scrollTop = p.top - (e.clientY - p.y);
  };
  const endPan = () => {
    pan.current = null;
  };

  return (
    <section aria-label="Board" className="flex flex-col gap-xs">
      <p id={instructionsId} className="sr-only">
        {editable
          ? "Press Enter to edit, arrow keys to move (Shift for bigger steps), Delete to delete."
          : "Read only while disconnected."}
      </p>
      <div
        ref={viewportRef}
        className="h-board-view w-full overflow-auto overscroll-contain rounded-lg border border-border"
      >
        <div
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endPan}
          onPointerCancel={endPan}
          className="sy-board-dots relative h-board-h w-board-w cursor-default"
        >
          {board.notes.map((entry) => (
            <NoteCard
              key={entry.note.id}
              entry={entry}
              editable={editable}
              describedBy={instructionsId}
              actions={actions}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
