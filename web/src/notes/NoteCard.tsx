import { createContext, memo, useContext, useEffect, useRef, type KeyboardEvent, type PointerEvent } from "react";
import type { NodeProps } from "@xyflow/react";
import type { NoteFlowNode } from "../canvas/nodes";
import { cn } from "../lib/utils";
import type { BoardNote } from "./board";
import { NOTE_COLOR_CLASSES } from "./colours";
import { confirmDelete, noteLabel } from "./label";

/** Arrow keys move by this many board units; with Shift, by KEY_STEP_BIG. */
const KEY_STEP = 10;
const KEY_STEP_BIG = 50;
/** After the last arrow key press, the position is committed (stored) this much later. */
const KEY_COMMIT_MS = 400;

export interface NoteActions {
  moveNote(id: string, x: number, y: number, final: boolean): void;
  /** Opens the note's editor: the Properties panel from md up, the editor sheet on phones. */
  openEditor(id: string): void;
  deleteNote(id: string): void;
  /** Pans the view to show the note, if it's off screen. */
  revealNote(id: string): void;
  /** Selects just this note (clicks and keyboard focus). */
  selectNote(id: string): void;
  clearSelection(): void;
  /** False while the Hand tool is on: touch taps don't edit (a double-click still does). */
  canTapEdit(): boolean;
}

/** Stable for the life of the board (the provider's value never changes), so notes don't re-render for it. */
export const NoteActionsContext = createContext<NoteActions | null>(null);
/** Id of the board's keyboard instructions. */
export const NoteHelpContext = createContext("");

/**
 * One note on the board. Note text is untrusted and only ever rendered as React text.
 * React Flow drags the whole note (mouse, pen or touch; it handles the movement threshold).
 * A click or keyboard focus selects it. A tap edits it (not under Hand); a double-click edits
 * it under any tool. Keys: Enter edits, arrow keys move (Shift for bigger steps), Delete
 * deletes, Escape clears the selection. Its size comes from the node (notes/size.ts).
 */
export function NoteCard({ entry, editable, selected }: { entry: BoardNote; editable: boolean; selected: boolean }) {
  const actions = useContext(NoteActionsContext);
  const describedBy = useContext(NoteHelpContext);
  const { note, dragging } = entry;
  const pending = entry.confirmed === null;
  const pointerType = useRef("mouse");
  const keyCommit = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef(note);
  latest.current = note;

  useEffect(() => () => clearTimeout(keyCommit.current), []);

  if (!actions) return null;
  const edit = () => {
    if (editable) actions.openEditor(note.id);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape" && selected) {
      e.preventDefault();
      actions.clearSelection();
      return;
    }
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
      actions.revealNote(note.id);
      clearTimeout(keyCommit.current);
      keyCommit.current = setTimeout(() => actions.moveNote(note.id, latest.current.x, latest.current.y, true), KEY_COMMIT_MS);
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
      aria-current={selected || undefined}
      data-note-id={note.id}
      onPointerDown={(e: PointerEvent<HTMLDivElement>) => {
        pointerType.current = e.pointerType || "mouse";
      }}
      // React Flow swallows the click that ends a drag, so these only see taps and clicks.
      onClick={() => {
        actions.selectNote(note.id);
        if (pointerType.current !== "mouse" && actions.canTapEdit()) edit();
      }}
      onDoubleClick={edit}
      onFocus={(e) => {
        actions.selectNote(note.id);
        // Keyboard focus only: a press that starts a drag mustn't pan the view.
        let keyboard = false;
        try {
          keyboard = e.currentTarget.matches(":focus-visible");
        } catch {
          // Older engines: no :focus-visible.
        }
        if (keyboard) actions.revealNote(note.id);
      }}
      onKeyDown={onKeyDown}
      className={cn(
        "flex size-full flex-col overflow-hidden rounded-sm border border-border p-sm text-sm text-note-fg shadow-md",
        "touch-none select-none",
        NOTE_COLOR_CLASSES[note.color],
        editable ? "cursor-grab" : "cursor-default",
        dragging && "cursor-grabbing shadow-lg",
        pending && "border-dashed opacity-75",
        selected && "ring-2 ring-accent ring-offset-2 ring-offset-board",
      )}
    >
      {/* Plain text only; wraps, keeps line breaks, and clips at the note's edge. */}
      <span aria-hidden="true" className="min-h-0 flex-1 overflow-hidden break-words whitespace-pre-wrap">
        {note.text}
      </span>
    </div>
  );
}

/** The React Flow node for a note. Memoised: a note re-renders only when its own entry changes. */
export const NoteNode = memo(function NoteNode({ data }: NodeProps<NoteFlowNode>) {
  return <NoteCard entry={data.entry} editable={data.editable} selected={data.selected} />;
});
