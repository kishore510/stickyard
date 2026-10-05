import { createContext, memo, useContext, useEffect, useRef, type KeyboardEvent, type PointerEvent } from "react";
import { useBoardUi } from "../canvas/uiStore";
import { useRoomUi } from "../rooms/roomStore";
import { NodeResizer, type NodeProps } from "@xyflow/react";
import { Check } from "lucide-react";
import { NOTE_MAX_H, NOTE_MAX_W, NOTE_MIN_H, NOTE_MIN_W, type NoteRect } from "@stickyard/shared";
import type { NoteFlowNode } from "../canvas/nodes";
import { noteClick } from "../canvas/pointer";
import { cn } from "../lib/utils";
import { isHeld, type BoardNote } from "./board";
import { InlineText } from "./InlineText";
import type { InlinePart } from "./inlineEdit";
import { NOTE_COLOR_CLASSES } from "./colours";
import { noteLabel } from "./label";
import { keyResize } from "./size";
import { splitTitleBody } from "./titleBody";
import { partTextClasses } from "./style";
import { VoteBadges, VoteControls, useNoteVoteLabel } from "../voting/NoteVotes";
import { voteFromKey } from "../voting/VoteButtons";
import { voteKey } from "../voting/voting";

/** Arrow keys move by this many board units; with Shift, by KEY_STEP_BIG. */
const KEY_STEP = 10;
const KEY_STEP_BIG = 50;
/** After the last arrow key press, the position (or size) is committed (stored) this much later. */
const KEY_COMMIT_MS = 400;

/** How an editor was asked for: the part to start in, and whether it was a finger tap. */
export interface EditorRequest {
  part?: InlinePart;
  touch?: boolean;
}

export interface NoteActions {
  moveNote(id: string, x: number, y: number, final: boolean): void;
  /** A resize handle was grabbed. False if the note can't be resized now. */
  startResize(id: string): boolean;
  resizeNote(id: string, rect: NoteRect, final: boolean): void;
  /** Opens the note's editor: in place (or Properties) from md up, the editor sheet on phones. */
  openEditor(id: string, how?: EditorRequest): void;
  /** Text typed in place. */
  setDraft(id: string, text: string): void;
  /** Ends editing in place, saving the draft if it changed. */
  commitEdit(id: string): void;
  /** Ends editing in place without saving (disconnected, or the note is held). */
  endEdit(id: string): void;
  deleteNote(id: string): void;
  /** Pans the view to show the note, if it's off screen. */
  revealNote(id: string): void;
  /** Selects just this note (clicks and keyboard focus). */
  selectNote(id: string): void;
  /** Shift/Ctrl-click: adds the note to the selection or takes it out (md and up). */
  toggleNote(id: string): void;
  clearSelection(): void;
  /** False while the Hand tool is on: touch taps don't edit (a double-click still does). */
  canTapEdit(): boolean;
  /** The whole selection when this note is one of several selected, else null. */
  groupOf(id: string): string[] | null;
  /** Arrow keys on a multi-selection: moves it all (clamped as a group), committed shortly after. */
  moveSelection(dx: number, dy: number): void;
  /** The Delete key on this note: the note, or the selection when there is one (asks first). */
  deleteFromKey(id: string): void;
}

/** Stable for the life of the board (the provider's value never changes), so notes don't re-render for it. */
export const NoteActionsContext = createContext<NoteActions | null>(null);
/** Id of the board's keyboard instructions. */
export const NoteHelpContext = createContext("");

/**
 * One note on the board. Note text is untrusted and only ever rendered as React text.
 * React Flow drags the whole note (mouse, pen or touch; it handles the movement threshold).
 * A click or keyboard focus selects it. A tap edits it (not under Hand); a double-click edits
 * it under any tool. Keys: Enter edits, arrow keys move (Shift for bigger steps), Alt+arrow keys
 * resize (Shift for bigger steps), Delete deletes, Escape clears the selection. Its size comes
 * from the node (notes/size.ts); its text style from the note's keys (notes/style.ts): the
 * title and the body each have their own.
 */
export function NoteCard({ entry, editable, selected, voteLabel = "" }: { entry: BoardNote; editable: boolean; selected: boolean; voteLabel?: string }) {
  const actions = useContext(NoteActionsContext);
  const describedBy = useContext(NoteHelpContext);
  const { note, dragging } = entry;
  const { title, body } = splitTitleBody(note.text);
  const hasBody = note.text.includes("\n");
  const pending = entry.confirmed === null;
  const pointerType = useRef("mouse");
  /** A press is focusing this note: the click (or drag) decides the selection, not the focus. */
  const pressing = useRef(false);
  const keyCommit = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef(note);
  latest.current = note;
  const cardRef = useRef<HTMLDivElement>(null);
  const inline = useBoardUi((s) => (s.inlineEdit?.id === note.id ? s.inlineEdit : null));
  // Editing in place survives a dropped connection (read-only until it's back, the draft kept).
  const editing = inline !== null && !isHeld(entry);

  useEffect(() => () => clearTimeout(keyCommit.current), []);
  // Grabbed while editing in place: stop (the draft stays, as in Properties).
  useEffect(() => {
    if (inline && !editing) actions?.endEdit(note.id);
  }, [inline, editing, actions, note.id]);

  if (!actions) return null;
  const edit = (part?: InlinePart) => {
    if (editable && !editing) actions.openEditor(note.id, { ...(part ? { part } : {}), touch: pointerType.current === "touch" });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Keys typed while editing in place are the text's, never the note's.
    if (e.target !== e.currentTarget) return;
    if (e.key === "Escape" && selected) {
      e.preventDefault();
      actions.clearSelection();
      return;
    }
    // D adds a dot, Shift+D takes one off, while a round is open (even on a locked board).
    const vote = voteKey(e);
    if (vote && voteFromKey(note.id, !pending, vote)) {
      e.preventDefault();
      return;
    }
    if (!editable) return;
    const group = actions.groupOf(note.id);
    const step = e.shiftKey ? KEY_STEP_BIG : KEY_STEP;
    const delta: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    if (e.altKey && delta[e.key]) {
      // Alt+arrows resize (top-left fixed), one note at a time. Not Ctrl or Meta: those belong to the browser.
      e.preventDefault();
      if (group) return;
      const rect = keyResize(note, e.key, e.shiftKey);
      if (pending || !rect || !actions.startResize(note.id)) return;
      actions.resizeNote(note.id, rect, false);
      actions.revealNote(note.id);
      clearTimeout(keyCommit.current);
      keyCommit.current = setTimeout(() => actions.resizeNote(note.id, latest.current, true), KEY_COMMIT_MS);
      return;
    }
    const move = delta[e.key];
    if (move && group) {
      e.preventDefault();
      actions.moveSelection(move[0], move[1]);
      actions.revealNote(note.id);
      return;
    }
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
      actions.deleteFromKey(note.id);
    }
  };

  return (
    <div
      ref={cardRef}
      role={editing ? "group" : "button"}
      tabIndex={0}
      aria-roledescription="note"
      data-editing={editing || undefined}
      aria-label={voteLabel ? `${noteLabel(note)} ${voteLabel}` : noteLabel(note)}
      aria-describedby={describedBy}
      aria-disabled={!editable || undefined}
      aria-busy={pending || undefined}
      aria-current={selected || undefined}
      data-note-id={note.id}
      onPointerDown={(e: PointerEvent<HTMLDivElement>) => {
        pointerType.current = e.pointerType || "mouse";
        pressing.current = true;
      }}
      // React Flow swallows the click that ends a drag, so these only see taps and clicks.
      onClick={(e) => {
        pressing.current = false;
        if (editing) return;
        if (noteClick(e) === "toggle") return actions.toggleNote(note.id);
        actions.selectNote(note.id);
        if (pointerType.current !== "mouse" && actions.canTapEdit()) edit();
      }}
      // The part double-clicked gets the caret.
      onDoubleClick={(e) => edit(e.target instanceof Element && e.target.closest("[data-note-body]") ? "body" : "title")}
      onBlur={() => {
        pressing.current = false;
      }}
      onFocus={(e) => {
        // Focus moving into the text being edited isn't the note's.
        if (e.target !== e.currentTarget) return;
        // Focus from a press: the click (or the drag) picks the selection, so a Shift-click or a
        // drag of a multi-selection doesn't collapse it first. Keyboard focus selects.
        if (pressing.current) {
          pressing.current = false;
          return;
        }
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
        "flex size-full flex-col overflow-hidden rounded-sm border border-border p-sm text-note-fg shadow-md",
        "touch-none select-none",
        NOTE_COLOR_CLASSES[note.color],
        editable ? "cursor-grab" : "cursor-default",
        dragging && "cursor-grabbing shadow-lg",
        pending && "border-dashed opacity-75",
        selected && "sy-selected",
        // Editing in place: a focus ring, a text cursor, and React Flow leaves it alone (no drag).
        editing && "nodrag cursor-text ring-4 ring-focus ring-offset-2 ring-offset-board",
      )}
    >
      {editing ? (
        <InlineText
          note={note}
          text={entry.draft ?? note.text}
          request={inline}
          readOnly={!editable}
          onDraft={(text) => actions.setDraft(note.id, text)}
          onCommit={(refocus) => {
            actions.commitEdit(note.id);
            if (refocus) cardRef.current?.focus();
          }}
        />
      ) : (
        <>
      {/* Plain text only; wraps, keeps line breaks, and clips at the note's edge. The title
          (first line) and the body (the rest) each have their own size, weight, slant, ink and
          alignment. */}
      <div aria-hidden="true" data-note-text className="min-h-0 flex-1 overflow-hidden break-words whitespace-pre-wrap">
        <p data-note-title className={cn(partTextClasses(note, "title"))}>
          {/* An empty title above a body still takes its line. */}
          {title === "" && hasBody ? "\u00a0" : title}
        </p>
        {hasBody && (
          <p data-note-body className={cn(partTextClasses(note, "body"))}>
            {body}
          </p>
        )}
      </div>
        </>
      )}
    </div>
  );
}

const rectOf = (p: { x: number; y: number; width: number; height: number }): NoteRect => ({ x: p.x, y: p.y, w: p.width, h: p.height });

/**
 * The React Flow node for a note. Memoised: a note re-renders only when its own entry changes.
 * When selected (and editable), React Flow's resizer shows handles at the corners (and lines
 * along the edges), as in Chalkline: the opposite corner stays put, min/max and the board's
 * edges (the node's extent) stop it, and the session sends the changes (throttled, then final).
 */
export const NoteNode = memo(function NoteNode({ id, data }: NodeProps<NoteFlowNode>) {
  const actions = useContext(NoteActionsContext);
  const several = useBoardUi((s) => s.selection.size + s.frames.size > 1);
  const voteLabel = useNoteVoteLabel(id);
  const votingOpen = useRoomUi((s) => s.room?.voting.state === "open");
  return (
    <>
      <NodeResizer
        isVisible={data.resizable}
        minWidth={NOTE_MIN_W}
        minHeight={NOTE_MIN_H}
        maxWidth={NOTE_MAX_W}
        maxHeight={NOTE_MAX_H}
        handleClassName="sy-resize-handle"
        lineClassName="sy-resize-line"
        onResizeStart={() => actions?.startResize(id)}
        onResize={(_, p) => actions?.resizeNote(id, rectOf(p), false)}
        onResizeEnd={(_, p) => actions?.resizeNote(id, rectOf(p), true)}
      />
      <NoteCard entry={data.entry} editable={data.editable} selected={data.selected} voteLabel={voteLabel} />
      <VoteBadges id={id} />
      {votingOpen && data.selected && !several && <VoteControls id={id} confirmed={data.entry.confirmed !== null} />}
      {data.selected && several && (
        <span data-select-badge aria-hidden="true" className="sy-select-badge">
          <Check strokeWidth={3} />
        </span>
      )}
    </>
  );
});
