import { StickyNote } from "lucide-react";
import { MAX_NOTE_TEXT, codePointLength } from "@stickyard/shared";
import { Button } from "../components/ui/button";
import { Sheet } from "../shell/Sheet";
import type { BoardNote, StylePatch } from "./board";
import { NoteFields } from "./NoteFields";

/**
 * Phones: editing a note, in the shared sheet frame (a full-height bottom sheet; the fields sit
 * at the top, so the on-screen keyboard can't hide them). It's the phone's Properties: the same
 * fields as the panel (notes/NoteFields.tsx), including colour, text style and Width/Height. The text is a local draft until it's committed:
 * Enter, Done, or leaving the sheet in any way (Esc, X, tapping outside, swiping down).
 * From md up the Properties panel is the editor instead, and this sheet isn't shown.
 */
export function NoteEditor({
  entry,
  author,
  onDraft,
  onCommit,
  onStyle,
  onSize,
  onDelete,
}: {
  entry: BoardNote;
  author: string;
  onDraft: (text: string) => void;
  /** Saves the draft (if it changed) and closes. */
  onCommit: () => void;
  onStyle: (change: StylePatch) => void;
  onSize: (w: number, h: number) => void;
  onDelete: () => void;
}) {
  const tooLong = codePointLength(entry.draft ?? entry.note.text) > MAX_NOTE_TEXT;

  return (
    <Sheet title="Edit note" icon={<StickyNote />} page="note" onClose={() => (tooLong ? undefined : onCommit())}>
      <form
        className="flex flex-col gap-md pb-md"
        onSubmit={(e) => {
          e.preventDefault();
          if (!tooLong) onCommit();
        }}
      >
        <NoteFields
          entry={entry}
          live
          author={author}
          onDraft={onDraft}
          onCommit={onCommit}
          onStyle={onStyle}
          onSize={onSize}
          onDelete={onDelete}
          commitOnBlur={false}
          autoFocus
        />
        <p className="rounded-md bg-surface-muted p-ms text-sm">
          Everyone in the session sees this note. If someone else changes it while you type, the last one saved wins.
        </p>
        <Button type="submit" variant="primary" className="self-start" disabled={tooLong}>
          Done
        </Button>
      </form>
    </Sheet>
  );
}
