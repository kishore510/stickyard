import { useId, type KeyboardEvent } from "react";
import { StickyNote, Trash2 } from "lucide-react";
import { MAX_NOTE_TEXT, codePointLength } from "@stickyard/shared";
import { Button } from "../components/ui/button";
import { FieldError, Label } from "../components/ui/field";
import { Textarea } from "../components/ui/textarea";
import { Sheet } from "../shell/Sheet";
import type { BoardNote } from "./board";
import { NOTE_COLOR_NAMES } from "./colours";
import { confirmDelete } from "./label";

/**
 * Editing a note's text, in the shared sheet frame: a full-height bottom sheet on phones (the
 * text box sits at the top, so the on-screen keyboard can't hide it), a side panel from md up.
 * The text is a local draft until it's committed: Enter, Done, or leaving the sheet in any way
 * (Esc, X, tapping outside, swiping down). Shift+Enter adds a line break.
 */
export function NoteEditor({
  entry,
  onDraft,
  onCommit,
  onDelete,
}: {
  entry: BoardNote;
  onDraft: (text: string) => void;
  /** Saves the draft (if it changed) and closes. */
  onCommit: () => void;
  onDelete: () => void;
}) {
  const id = useId();
  const text = entry.draft ?? entry.note.text;
  const length = codePointLength(text);
  const tooLong = length > MAX_NOTE_TEXT;

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (!tooLong) onCommit();
    }
  };

  return (
    <Sheet title="Edit note" icon={<StickyNote />} page="note" onClose={() => (tooLong ? undefined : onCommit())}>
      <form
        className="flex flex-col gap-md pb-md"
        onSubmit={(e) => {
          e.preventDefault();
          if (!tooLong) onCommit();
        }}
      >
        <div className="flex flex-col gap-sm">
          <Label htmlFor={`${id}-text`}>{NOTE_COLOR_NAMES[entry.note.color]} note</Label>
          <Textarea
            id={`${id}-text`}
            data-autofocus
            rows={6}
            maxLength={MAX_NOTE_TEXT * 2}
            value={text}
            onChange={(e) => onDraft(e.target.value)}
            onKeyDown={onKeyDown}
            aria-describedby={`${id}-help ${id}-count`}
            aria-invalid={tooLong || undefined}
          />
          <div className="flex justify-between gap-sm text-sm text-fg-muted">
            <span id={`${id}-help`}>Enter saves. Shift+Enter adds a new line.</span>
            <span id={`${id}-count`} aria-live="polite">
              {length} / {MAX_NOTE_TEXT}
            </span>
          </div>
          {tooLong && <FieldError>Notes can be up to {MAX_NOTE_TEXT} characters.</FieldError>}
        </div>
        <p className="rounded-md bg-surface-muted p-ms text-sm">
          Everyone in the session sees this note. If someone else changes it while you type, the last one saved wins.
        </p>
        <div className="flex flex-wrap gap-sm">
          <Button type="submit" variant="primary" disabled={tooLong}>
            Done
          </Button>
          <Button
            onClick={() => {
              if (confirmDelete(text)) onDelete();
            }}
          >
            <Trash2 />
            Delete note
          </Button>
        </div>
      </form>
    </Sheet>
  );
}
