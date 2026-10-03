import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from "react";
import { cn } from "../lib/utils";
import type { BoardNote } from "./board";
import { NOTE_COLOR_CLASSES } from "./colours";
import { confirmDelete, noteLabel } from "./label";

/** Pointer travel (px) before a press becomes a drag rather than a tap. */
const DRAG_THRESHOLD = 4;
/** Arrow keys move by this many board units; with Shift, by KEY_STEP_BIG. */
const KEY_STEP = 10;
const KEY_STEP_BIG = 50;
/** After the last arrow key press, the position is committed (stored) this much later. */
const KEY_COMMIT_MS = 400;

export interface NoteActions {
  startDrag(id: string): boolean;
  moveNote(id: string, x: number, y: number, final: boolean): void;
  openEditor(id: string): void;
  deleteNote(id: string): void;
}

/**
 * One note on the board. Note text is untrusted and only ever rendered as React text.
 * Drag to move (pointer events, so mouse, pen and touch), tap or Enter to edit,
 * arrow keys to move, Delete to delete.
 */
export function NoteCard({
  entry,
  editable,
  describedBy,
  actions,
}: {
  entry: BoardNote;
  editable: boolean;
  /** Id of the keyboard instructions. */
  describedBy: string;
  actions: NoteActions;
}) {
  const { note, dragging } = entry;
  const pending = entry.confirmed === null;
  const press = useRef<{
    pointer: number;
    startX: number;
    startY: number;
    noteX: number;
    noteY: number;
    drag: boolean;
  } | null>(null);
  const keyCommit = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef(note);
  latest.current = note;

  useEffect(() => () => clearTimeout(keyCommit.current), []);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (!editable || e.button !== 0) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    press.current = {
      pointer: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      noteX: note.x,
      noteY: note.y,
      drag: false,
    };
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const p = press.current;
    if (!p || p.pointer !== e.pointerId) return;
    const dx = e.clientX - p.startX;
    const dy = e.clientY - p.startY;
    if (!p.drag) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      if (!actions.startDrag(note.id)) {
        press.current = null;
        return;
      }
      p.drag = true;
    }
    actions.moveNote(note.id, p.noteX + dx, p.noteY + dy, false);
  };

  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const p = press.current;
    press.current = null;
    if (!p || p.pointer !== e.pointerId) return;
    if (p.drag) actions.moveNote(note.id, p.noteX + e.clientX - p.startX, p.noteY + e.clientY - p.startY, true);
    else actions.openEditor(note.id);
  };

  const onPointerCancel = () => {
    const p = press.current;
    press.current = null;
    // Commit wherever the note got to.
    if (p?.drag) actions.moveNote(note.id, latest.current.x, latest.current.y, true);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!editable) return;
    const step = e.shiftKey ? KEY_STEP_BIG : KEY_STEP;
    const delta: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const move = delta[e.key];
    if (move) {
      e.preventDefault();
      if (pending) return;
      actions.moveNote(note.id, note.x + move[0], note.y + move[1], false);
      clearTimeout(keyCommit.current);
      keyCommit.current = setTimeout(
        () => actions.moveNote(note.id, latest.current.x, latest.current.y, true),
        KEY_COMMIT_MS,
      );
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      actions.openEditor(note.id);
      return;
    }
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      if (confirmDelete(note.text)) actions.deleteNote(note.id);
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      aria-roledescription="note"
      aria-label={noteLabel(note)}
      aria-describedby={describedBy}
      aria-disabled={!editable || undefined}
      aria-busy={pending || undefined}
      data-note-id={note.id}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onKeyDown={onKeyDown}
      style={{ transform: `translate(${note.x}px, ${note.y}px)` }}
      className={cn(
        "absolute top-0 left-0 flex size-note flex-col overflow-hidden rounded-sm border border-border p-sm text-sm text-note-fg shadow-md",
        "touch-none select-none",
        NOTE_COLOR_CLASSES[note.color],
        editable ? "cursor-grab" : "cursor-default",
        dragging ? "z-10 cursor-grabbing shadow-lg" : "sy-note-motion",
        pending && "border-dashed opacity-75",
      )}
    >
      {/* Plain text only; wraps, keeps line breaks, and clips at the note's edge. */}
      <span aria-hidden="true" className="min-h-0 flex-1 overflow-hidden break-words whitespace-pre-wrap">
        {note.text}
      </span>
    </div>
  );
}
