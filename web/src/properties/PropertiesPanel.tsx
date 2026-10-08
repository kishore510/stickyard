import { useId, type ReactNode } from "react";
import { Eraser, Power, Trash2 } from "lucide-react";
import { BOARD_HEIGHT, BOARD_WIDTH, MAX_NOTES_PER_ROOM, MAX_SHAPES_PER_ROOM, NOTE_STYLE_FIELDS, type FrameColor, type Note, type OrderAction, type Participant } from "@stickyard/shared";
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import { useBoardUi } from "../canvas/uiStore";
import { onlySelected, orderedIds } from "../canvas/selection";
import { confirmDeleteSelection, deleteCounts, itemsInWords, selectionLabel } from "../canvas/frameSelect";
import { confirmFrameDelete } from "../frames/label";
import { findFrame, framedNotes, type FrameEdit } from "../frames/board";
import { FrameFields } from "../frames/FrameFields";
import { FramesFields } from "../frames/FramesFields";
import { findNote, type Board, type StylePatch } from "../notes/board";
import { NOTE_COLOR_NAMES } from "../notes/colours";
import { authorName, confirmDelete, confirmDeleteNotes } from "../notes/label";
import { NoteFields } from "../notes/NoteFields";
import { OrderSection } from "../notes/OrderFields";
import { ColourSection, PartTextSection, SizeSection, type MixedFields } from "../notes/StyleFields";
import { clearBoardReason, confirmClearBoard } from "./clearBoard";
import { ResultsList } from "../voting/Results";
import { ExportSection } from "../export/ExportSection";
import { findShape, type ShapeEdit } from "../shapes/board";
import { confirmShapeDelete } from "../shapes/label";
import { ShapeFields, ShapesFields } from "../shapes/ShapeFields";
import { SHAPE_KIND_NAMES } from "../shapes/style";
import type { ResultRow } from "../voting/voting";
import { LOCK_TEXT, confirmEndSession, endSessionReason, withLock } from "../facilitation/lock";

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
  yourIds?: ReadonlySet<string>;
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
  editFrame(id: string, change: FrameEdit): boolean;
  /** Colour and title style for several frames at once (v0.20.0). */
  editFrames?(ids: readonly string[], change: FrameEdit): boolean;
  setFrameSize(id: string, w: number, h: number): boolean;
  deleteFrame(id: string): void;
  /** Deletes notes and frames together (v0.20.0): one paced run, one report, one undo step. */
  deleteSelection(noteIds: readonly string[], frameIds: readonly string[], shapeIds?: readonly string[]): boolean;
  /** Deletes every note and frame (asked first here); false if it couldn't start. */
  clearBoard(): boolean;
  /** An add run (template, duplicate, restore) is still being sent. */
  adding: boolean;
  /** A clear is still running. */
  clearing: boolean;
  /** A delete of a selection with frames is still running. */
  deleting?: boolean;
  /** A guest on a locked board (facilitation UI): read-only, and says why. */
  locked?: boolean;
  /** This visit is a host: End session sits next to Clear board. */
  isHost?: boolean;
  /** Ends the session for everyone (asked first here); false if it couldn't start. */
  endSession?: () => boolean;
  /** Shapes (protocol v15): text being typed, a committed text or style, a size, a delete. */
  setShapeDraft?(id: string, draft: string | null): void;
  editShape?(id: string, change: ShapeEdit): boolean;
  /** Text style, fill and border for several shapes at once. */
  editShapes?(ids: readonly string[], change: ShapeEdit): boolean;
  setShapeSize?(id: string, w: number, h: number): boolean;
  deleteShape?(id: string): void;
  /** Dot voting results while a round is closed (sorted; null otherwise): the board summary lists them first. */
  results?: readonly ResultRow[] | null;
  /** A results row: selects that note and moves the view to it. */
  onPickResult?: (noteId: string) => void;
  /** React Flow's viewport element, for Export PNG (v0.22.0); without it there's no Export section. */
  exportViewport?: () => HTMLElement | null;
  /** A silent round is running (v0.27.0): Clear board and Export are off. */
  silent?: boolean;
  /** Everyone's notes, sealed ones of others included (absent: the board's). */
  totalNotes?: number;
}

/** The style and size fields whose values differ between these notes. */
export function mixedFields(notes: readonly Note[]): MixedFields {
  const first = notes[0];
  if (!first) return new Set();
  const keys = [...NOTE_STYLE_FIELDS, "w", "h"] as const;
  return new Set(keys.filter((k) => notes.some((n) => n[k] !== first[k])));
}

const noop = () => {};

/** Frames with notes: what they do together (arrange and style work on one kind at a time). */
function GroupFields() {
  return (
    <p data-group-summary="" className="rounded-md bg-surface-muted p-ms text-sm text-fg-muted">
      Drag any of them to move them all; each frame brings the notes and shapes inside it. Delete removes what’s selected; items inside a
      frame stay unless they’re selected. To arrange, select only notes and shapes, or only frames. To change colour, select one kind.
    </p>
  );
}

/** Several notes selected: what they share, read-only (they move, arrange, restack and delete together). */
function SelectionFields({ notes, live, onOrder }: { notes: Note[]; live: boolean; onOrder: (action: OrderAction) => void }) {
  const first = notes[0];
  if (!first) return null;
  const mixed = mixedFields(notes);
  return (
    <>
      <p className="rounded-md bg-surface-muted p-ms text-sm text-fg-muted">
        Drag one to move them all, or use Arrange in the top bar to align, distribute or match their size. Colour and text style
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

/** Nothing selected: the board's counts, and Clear board (asks once; one undo brings it all back). */
function Summary({ room }: { room: PropertiesRoom }) {
  const hintId = useId();
  const notes = room.board.notes.length;
  const frames = room.board.frames.length;
  const shapes = room.board.shapes.length;
  // During a silent round the count includes the notes others are writing (not shown yet).
  const total = room.totalNotes ?? notes;
  const reason = withLock(clearBoardReason({ live: room.live, notes, frames, shapes, busy: room.adding, clearing: room.clearing, deleting: room.deleting ?? false, silent: room.silent ?? false }), {
    live: room.live,
    locked: room.locked ?? false,
    isHost: room.isHost ?? false,
  });
  const endReason = endSessionReason({ live: room.live, busy: room.adding, clearing: room.clearing || (room.deleting ?? false) });
  return (
    <>
      {room.results && <ResultsList rows={room.results} onPick={(id) => room.onPickResult?.(id)} />}
      <p className="text-sm text-fg-muted tabular-nums">
        {total} of {MAX_NOTES_PER_ROOM} notes{shapes > 0 ? `, ${shapes} of ${MAX_SHAPES_PER_ROOM} shapes` : ""}. Board size {BOARD_WIDTH} × {BOARD_HEIGHT}.
      </p>
      <p className="text-sm text-fg-muted">Select a note, shape or frame to see and edit it here.</p>
      <div className="flex flex-col gap-xs">
        <Button
          aria-describedby={reason ? hintId : undefined}
          disabled={reason !== null}
          onClick={() => {
            if (!confirmClearBoard(notes, frames, undefined, shapes)) return;
            if (room.clearBoard()) useBoardUi.getState().clearSelection();
          }}
          className="self-start text-status-error"
        >
          <Eraser />
          Clear board
        </Button>
        {reason && (
          <p id={hintId} className="text-xs text-fg-muted">
            {reason}
          </p>
        )}
      </div>
      {room.exportViewport && <ExportSection board={room.board} results={room.results ?? null} viewport={room.exportViewport} silent={room.silent ?? false} />}
      {room.isHost && room.endSession && (
        <div className="flex flex-col gap-xs border-t border-border pt-md">
          <p className="text-sm text-fg-muted">You’re the host. Ending the session deletes the board for everyone.</p>
          <Button
            aria-describedby={endReason ? `${hintId}-end` : undefined}
            aria-disabled={endReason !== null || undefined}
            onClick={() => {
              if (endReason !== null || !confirmEndSession()) return;
              room.endSession?.();
            }}
            className="self-start text-status-error"
          >
            <Power />
            End session
          </Button>
          {endReason && (
            <p id={`${hintId}-end`} className="text-xs text-fg-muted">
              {endReason}
            </p>
          )}
        </div>
      )}
    </>
  );
}

export function PropertiesContent({ room, collapse }: { room: PropertiesRoom; collapse: ReactNode }) {
  const selection = useBoardUi((s) => s.selection);
  // A guest on a locked board sees everything read-only (the relay would refuse changes).
  const editable = room.live && !(room.locked ?? false);
  const editRequest = useBoardUi((s) => s.editRequest);
  const id = onlySelected(selection);
  const entry = id === null ? undefined : findNote(room.board, id);
  const text = entry ? (entry.draft ?? entry.note.text) : "";
  const many = selection.size > 1 ? orderedIds(selection).flatMap((n) => findNote(room.board, n)?.note ?? []) : [];
  const frameId = useBoardUi((s) => s.frameSelected);
  const frame = frameId === null ? undefined : findFrame(room.board, frameId);
  // A selection of several items with frames or shapes in it (v0.20.0; shapes v15): a summary with Delete.
  const frameSet = useBoardUi((s) => s.frames);
  const shapeSet = useBoardUi((s) => s.shapes);
  const several = frameSet.size + shapeSet.size > 0 && frameSet.size + selection.size + shapeSet.size > 1;
  const groupFrames = several ? orderedIds(frameSet).flatMap((f) => findFrame(room.board, f) ?? []) : [];
  const groupShapes = several ? orderedIds(shapeSet).flatMap((f) => findShape(room.board, f) ?? []) : [];
  const groupNotes = several ? orderedIds(selection).flatMap((n) => findNote(room.board, n)?.note ?? []) : [];
  const group = groupFrames.length + groupShapes.length > 0 && groupFrames.length + groupNotes.length + groupShapes.length > 1;
  const groupWhat = itemsInWords(groupNotes.length, groupFrames.length, groupShapes.length);
  // One shape selected alone (protocol v15).
  const shapeId = useBoardUi((s) => s.shapeSelected);
  const shape = shapeId === null ? undefined : findShape(room.board, shapeId);

  return (
    <div className="px-md">
      <div className="sticky top-0 z-10 -mx-md flex items-center bg-surface pr-md">
        {collapse}
        <h2 className="flex min-h-touch min-w-0 flex-1 items-center justify-center border-b-2 border-accent text-sm font-medium">Properties</h2>
      </div>
      <div className="flex min-h-touch items-center gap-xs">
        {/* A selection summary wraps at the panel's narrowest; a note or frame name stays on one line. */}
        <h3 className={cn("min-w-0 flex-1 text-sm font-semibold", group ? "break-words" : "truncate")}>
          {group ? selectionLabel(groupNotes.length, groupFrames.length, groupShapes.length) : shape ? (shape.shape.kind === "text" ? "Text box" : SHAPE_KIND_NAMES[shape.shape.kind]) : frame ? "Frame" : many.length > 1 ? `${many.length} selected` : entry ? `${NOTE_COLOR_NAMES[entry.note.color]} note` : "Board"}
        </h3>
        {group && (
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Delete ${groupWhat}`}
            title={`Delete ${groupWhat} (Del)`}
            disabled={!editable}
            onClick={() => {
              const noteIds = groupNotes.map((n) => n.id);
              const frameIds = groupFrames.map((f) => f.frame.id);
              const shapeIds = groupShapes.map((x) => x.shape.id);
              if (!confirmDeleteSelection(deleteCounts(room.board, noteIds, frameIds, shapeIds))) return;
              if (room.deleteSelection(noteIds, frameIds, shapeIds)) useBoardUi.getState().clearSelection();
            }}
            className="text-status-error"
          >
            <Trash2 />
          </Button>
        )}
        {!group && shape && (
          <Button
            variant="ghost"
            size="icon"
            aria-label={shape.shape.kind === "text" ? "Delete text box" : "Delete shape"}
            title="Delete (Del)"
            disabled={!editable}
            onClick={() => {
              if (!confirmShapeDelete(shape.shape)) return;
              room.deleteShape?.(shape.shape.id);
              useBoardUi.getState().clearSelection();
            }}
            className="text-status-error"
          >
            <Trash2 />
          </Button>
        )}
        {!group && frame && (
          <Button
            variant="ghost"
            size="icon"
            aria-label="Delete frame"
            title="Delete frame (Del). Its notes stay."
            disabled={!editable}
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
        {!group && many.length > 1 && (
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Delete ${many.length} notes`}
            title={`Delete ${many.length} notes (Del)`}
            disabled={!editable}
            onClick={() => {
              if (!confirmDeleteNotes(many.length)) return;
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
            disabled={!editable}
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
        {room.live && room.locked && (selection.size > 0 || frameSet.size > 0 || shapeSet.size > 0) && (
          <p data-locked-reason="" className="rounded-md bg-surface-muted p-ms text-sm">
            {LOCK_TEXT.reason}
          </p>
        )}
        {group && groupNotes.length === 0 && groupShapes.length === 0 ? (
          <FramesFields frames={groupFrames.map((f) => f.frame)} live={editable} onEdit={(change) => room.editFrames?.(groupFrames.map((f) => f.frame.id), change)} />
        ) : group && groupNotes.length === 0 && groupFrames.length === 0 ? (
          <ShapesFields shapes={groupShapes.map((x) => x.shape)} live={editable} onEdit={(change) => room.editShapes?.(groupShapes.map((x) => x.shape.id), change)} />
        ) : group ? (
          <GroupFields />
        ) : shape ? (
          <ShapeFields
            entry={shape}
            live={editable}
            author={authorName(shape.shape.authorId, room)}
            onDraft={(t) => room.setShapeDraft?.(shape.shape.id, t)}
            onCommit={() => {
              if (shape.draft !== null) room.editShape?.(shape.shape.id, { text: shape.draft });
            }}
            onEdit={(change) => room.editShape?.(shape.shape.id, change)}
            onSize={(w, h) => room.setShapeSize?.(shape.shape.id, w, h)}
            onOrder={(action) => room.orderNotes([shape.shape.id], action)}
          />
        ) : frame ? (
          <FrameFields
            entry={frame}
            live={editable}
            author={authorName(frame.frame.authorId, room)}
            onDraft={(t) => room.setFrameDraft(frame.frame.id, t)}
            onCommit={() => {
              if (frame.draft !== null) room.editFrame(frame.frame.id, { title: frame.draft });
            }}
            onColour={(color) => room.editFrame(frame.frame.id, { color })}
            onStyle={(change) => room.editFrame(frame.frame.id, change)}
            onSize={(w, h) => room.setFrameSize(frame.frame.id, w, h)}
          />
        ) : many.length > 1 ? (
          <SelectionFields notes={many} live={editable} onOrder={(action) => room.orderNotes(many.map((n) => n.id), action)} />
        ) : entry ? (
          <NoteFields
            entry={entry}
            live={editable}
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
          <Summary room={room} />
        )}
      </div>
    </div>
  );
}
