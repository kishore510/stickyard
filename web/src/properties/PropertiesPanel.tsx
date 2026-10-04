import type { ReactNode } from "react";
import { Trash2 } from "lucide-react";
import { BOARD_HEIGHT, BOARD_WIDTH, MAX_NOTES_PER_ROOM, NOTE_STYLE_FIELDS, type FrameColor, type Note, type OrderAction, type Participant } from "@stickyard/shared";
import { Button } from "../components/ui/button";
import { useBoardUi } from "../canvas/uiStore";
import { onlySelected, orderedIds } from "../canvas/selection";
import { confirmFrameDelete } from "../frames/label";
import { findFrame, framedNotes } from "../frames/board";
import { FrameFields } from "../frames/FrameFields";
import { findNote, type Board, type StylePatch } from "../notes/board";
import { NOTE_COLOR_NAMES } from "../notes/colours";
import { authorName, confirmDelete } from "../notes/label";
import { NoteFields } from "../notes/NoteFields";
import { OrderSection } from "../notes/OrderFields";
import { ColourSection, PartTextSection, SizeSection, type MixedFields } from "../notes/StyleFields";

/*
 * The Properties panel's content (md and up, inside the SidePanel frame), laid out like
 * Chalkline's: a sticky tab row with the collapse button, a header naming what's selected (with
 * Delete), then its fields. Nothing selected: a summary of the board. One note: its fields
 * (notes/NoteFields.tsx), which are the note editor from md up. Several: "N selected" with
 * Delete, Bring to front / Send to back, and their colour, text style and size shown read-only
 * ("Mixed" where they differ); changing those for several notes at once isn't possible yet.
 * Read-only while disconnected.
 */

export interface PropertiesRoom {
  board: Board;
  live: boolean;
  you: Participant | null;
  people: ReadonlyMap<string, Participant>;
  participants: readonly Participant[];
  setDraft(id: string, draft: string | null): void;
  editNote(id: string, text: string): boolean;
  styleNote(id: string, change: StylePatch): boolean;
  setNoteSize(id: string, w: number, h: number): boolean;
  deleteNote(id: string): void;
  deleteNotes(ids: readonly string[]): void;
  orderNotes(ids: readonly string[], action: OrderAction): boolean;
  setFrameDraft(id: string, draft: string | null): void;
  editFrame(id: string, change: { title?: string; color?: FrameColor }): boolean;
  setFrameSize(id: string, w: number, h: number): boolean;
  deleteFrame(id: string): void;
}

/** The style and size fields whose values differ between these notes. */
export function mixedFields(notes: readonly Note[]): MixedFields {
  const first = notes[0];
  if (!first) return new Set();
  const keys = [...NOTE_STYLE_FIELDS, "w", "h"] as const;
  return new Set(keys.filter((k) => notes.some((n) => n[k] !== first[k])));
}

const noop = () => {};

/** Several notes selected: what they share, read-only (they move, arrange, restack and delete together). */
function SelectionFields({ notes, live, onOrder }: { notes: Note[]; live: boolean; onOrder: (action: OrderAction) => void }) {
  const first = notes[0];
  if (!first) return null;
  const mixed = mixedFields(notes);
  return (
    <>
      <p className="rounded-md bg-surface-muted p-ms text-sm text-fg-muted">
        Drag one to move them all, or use the bar at the top of the board to align, distribute or match their size. Colour and text style
        change one note at a time.
      </p>
      <ColourSection note={first} live={false} onStyle={noop} mixed={mixed} />
      <PartTextSection part="title" note={first} live={false} onStyle={noop} mixed={mixed} />
      <PartTextSection part="body" note={first} live={false} onStyle={noop} mixed={mixed} />
      <SizeSection note={first} live={false} onSize={noop} mixed={mixed} />
      <OrderSection live={live} onOrder={onOrder} />
    </>
  );
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
  const many = selection.size > 1 ? orderedIds(selection).flatMap((n) => findNote(room.board, n)?.note ?? []) : [];
  const frameId = useBoardUi((s) => s.frameSelected);
  const frame = frameId === null ? undefined : findFrame(room.board, frameId);

  return (
    <div className="px-md">
      <div className="sticky top-0 z-10 -mx-md flex items-center bg-surface pr-md">
        {collapse}
        <h2 className="flex min-h-touch min-w-0 flex-1 items-center justify-center border-b-2 border-accent text-sm font-medium">Properties</h2>
      </div>
      <div className="flex min-h-touch items-center gap-xs">
        <h3 className="min-w-0 flex-1 truncate text-sm font-semibold">
          {frame ? "Frame" : many.length > 1 ? `${many.length} selected` : entry ? `${NOTE_COLOR_NAMES[entry.note.color]} note` : "Board"}
        </h3>
        {frame && (
          <Button
            variant="ghost"
            size="icon"
            aria-label="Delete frame"
            title="Delete frame (Del). Its notes stay."
            disabled={!room.live}
            onClick={() => {
              const inside = framedNotes(frame.frame, room.board.notes.map((n) => n.note)).length;
              if (!confirmFrameDelete(frame.frame.title, inside)) return;
              room.deleteFrame(frame.frame.id);
              useBoardUi.getState().clearSelection();
            }}
            className="text-status-error"
          >
            <Trash2 />
          </Button>
        )}
        {many.length > 1 && (
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Delete ${many.length} notes`}
            title={`Delete ${many.length} notes (Del)`}
            disabled={!room.live}
            onClick={() => {
              if (!confirmDelete(many.map((n) => n.text).join(""))) return;
              room.deleteNotes(many.map((n) => n.id));
              useBoardUi.getState().clearSelection();
            }}
            className="text-status-error"
          >
            <Trash2 />
          </Button>
        )}
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
        {frame ? (
          <FrameFields
            entry={frame}
            live={room.live}
            author={authorName(frame.frame.authorId, room)}
            onDraft={(t) => room.setFrameDraft(frame.frame.id, t)}
            onCommit={() => {
              if (frame.draft !== null) room.editFrame(frame.frame.id, { title: frame.draft });
            }}
            onColour={(color) => room.editFrame(frame.frame.id, { color })}
            onSize={(w, h) => room.setFrameSize(frame.frame.id, w, h)}
          />
        ) : many.length > 1 ? (
          <SelectionFields notes={many} live={room.live} onOrder={(action) => room.orderNotes(many.map((n) => n.id), action)} />
        ) : entry ? (
          <NoteFields
            entry={entry}
            live={room.live}
            author={authorName(entry.note.authorId, room)}
            onDraft={(t) => room.setDraft(entry.note.id, t)}
            onCommit={() => {
              if (entry.draft !== null) room.editNote(entry.note.id, entry.draft);
            }}
            onStyle={(change) => room.styleNote(entry.note.id, change)}
            onSize={(w, h) => room.setNoteSize(entry.note.id, w, h)}
            onDelete={() => room.deleteNote(entry.note.id)}
            onOrder={(action) => room.orderNotes([entry.note.id], action)}
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
