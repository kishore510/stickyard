import type { ReactNode } from "react";
import { Trash2 } from "lucide-react";
import { BOARD_HEIGHT, BOARD_WIDTH, MAX_NOTES_PER_ROOM, type Participant } from "@stickyard/shared";
import { Button } from "../components/ui/button";
import { useBoardUi } from "../canvas/uiStore";
import { onlySelected } from "../canvas/selection";
import { findNote, type Board } from "../notes/board";
import { NOTE_COLOR_NAMES } from "../notes/colours";
import { authorName, confirmDelete } from "../notes/label";
import { NoteFields } from "../notes/NoteFields";

/*
 * The Properties panel's content (md and up, inside the SidePanel frame), laid out like
 * Chalkline's: a sticky tab row with the collapse button, a header naming what's selected (with
 * Delete), then its fields. Nothing selected: a summary of the board. One note: its fields
 * (notes/NoteFields.tsx), which are the note editor from md up. Read-only while disconnected.
 */

export interface PropertiesRoom {
  board: Board;
  live: boolean;
  you: Participant | null;
  people: ReadonlyMap<string, Participant>;
  participants: readonly Participant[];
  setDraft(id: string, draft: string | null): void;
  editNote(id: string, text: string): boolean;
  deleteNote(id: string): void;
}

function Summary({ count }: { count: number }) {
  return (
    <>
      <p className="text-sm text-fg-muted tabular-nums">
        {count} of {MAX_NOTES_PER_ROOM} notes. Board size {BOARD_WIDTH} × {BOARD_HEIGHT}.
      </p>
      <p className="text-sm text-fg-muted">Select a note to see and edit it here.</p>
    </>
  );
}

export function PropertiesContent({ room, collapse }: { room: PropertiesRoom; collapse: ReactNode }) {
  const selection = useBoardUi((s) => s.selection);
  const editRequest = useBoardUi((s) => s.editRequest);
  const id = onlySelected(selection);
  const entry = id === null ? undefined : findNote(room.board, id);
  const text = entry ? (entry.draft ?? entry.note.text) : "";

  return (
    <div className="px-md">
      <div className="sticky top-0 z-10 -mx-md flex items-center bg-surface pr-md">
        {collapse}
        <h2 className="flex min-h-touch min-w-0 flex-1 items-center justify-center border-b-2 border-accent text-sm font-medium">Properties</h2>
      </div>
      <div className="flex min-h-touch items-center gap-xs">
        <h3 className="min-w-0 flex-1 truncate text-sm font-semibold">{entry ? `${NOTE_COLOR_NAMES[entry.note.color]} note` : "Board"}</h3>
        {entry && (
          <Button
            variant="ghost"
            size="icon"
            title="Delete note (Del)"
            disabled={!room.live}
            onClick={() => {
              if (confirmDelete(text)) room.deleteNote(entry.note.id);
            }}
            className="text-status-error"
          >
            <Trash2 />
            <span className="sr-only">Delete note</span>
          </Button>
        )}
      </div>
      <div className="flex flex-col gap-md pb-md">
        {entry ? (
          <NoteFields
            entry={entry}
            live={room.live}
            author={authorName(entry.note.authorId, room)}
            onDraft={(t) => room.setDraft(entry.note.id, t)}
            onCommit={() => {
              if (entry.draft !== null) room.editNote(entry.note.id, entry.draft);
            }}
            onDelete={() => room.deleteNote(entry.note.id)}
            showDelete={false}
            commitOnBlur
            focusRequest={editRequest?.id === entry.note.id ? editRequest.n : null}
            onFocused={() => useBoardUi.setState({ editRequest: null })}
          />
        ) : (
          <Summary count={room.board.notes.length} />
        )}
      </div>
    </div>
  );
}
