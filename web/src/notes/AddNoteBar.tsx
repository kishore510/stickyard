import { Plus } from "lucide-react";
import { MAX_NOTES_PER_ROOM, NOTE_COLORS, type NoteColor } from "@stickyard/shared";
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import { NOTE_COLOR_CLASSES, NOTE_COLOR_NAMES } from "./colours";

/**
 * The floating bottom bar (Chalkline's thumb toolbar), reserved in slice 0.5 for this:
 * a colour choice and Add note. Fixed to the bottom of the screen, above the safe area.
 */
export function AddNoteBar({
  color,
  onColor,
  onAdd,
  disabledReason,
}: {
  color: NoteColor;
  onColor: (color: NoteColor) => void;
  onAdd: () => void;
  /** Why adding isn't possible right now, or null. Shown above the bar. */
  disabledReason: string | null;
}) {
  const disabled = disabledReason !== null;
  return (
    <div className="sy-safe-x sy-safe-bottom pointer-events-none fixed inset-x-0 bottom-0 z-40 flex flex-col items-center gap-xs">
      {disabledReason && (
        <p role="status" className="pointer-events-auto rounded-md bg-surface px-ms py-xs text-sm shadow-md">
          {disabledReason}
        </p>
      )}
      <div
        role="toolbar"
        aria-label="Add a note"
        className="pointer-events-auto flex max-w-full items-center gap-toolbar rounded-lg border border-border bg-surface p-xs shadow-lg"
      >
        <div role="radiogroup" aria-label="Note colour" className="flex items-center">
          {NOTE_COLORS.map((key) => (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={key === color}
              aria-label={NOTE_COLOR_NAMES[key]}
              title={NOTE_COLOR_NAMES[key]}
              disabled={disabled}
              onClick={() => onColor(key)}
              className="flex size-touch cursor-pointer items-center justify-center rounded-md disabled:cursor-default disabled:opacity-50"
            >
              <span
                aria-hidden="true"
                className={cn(
                  "size-swatch rounded-full border border-border-strong",
                  NOTE_COLOR_CLASSES[key],
                  key === color && "ring-2 ring-accent ring-offset-2 ring-offset-surface",
                )}
              />
            </button>
          ))}
        </div>
        <Button variant="primary" onClick={onAdd} disabled={disabled} aria-label="Add note" className="px-ms sm:px-md">
          <Plus />
          <span className="hidden sm:inline">Add note</span>
        </Button>
      </div>
    </div>
  );
}

export const notesFullReason = `The board is full (${MAX_NOTES_PER_ROOM} notes). Delete one to add another.`;
