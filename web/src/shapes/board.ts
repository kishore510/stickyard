import {
  SHAPE_EDIT_FIELDS,
  clampShapePosition,
  clampShapeRect,
  shapeDefaults,
  type NoteRect,
  type Shape,
  type ShapeEditField,
  type ShapeItem,
  type ShapeKind,
} from "@stickyard/shared";
import { localId, topZ, type Board } from "../notes/board";

/*
 * Shapes on the board as this page sees them (protocol v15): the server's shapes plus optimistic
 * local changes, exactly like notes (notes/board.ts) and frames (frames/board.ts). Pure functions
 * on the shared Board, each returning a new Board, or the same one when nothing changed.
 *
 * - `confirmed` is what the server last sent; `shape` is what's shown. A refusal rolls back.
 * - A stale update (lower rev than confirmed) is ignored.
 * - `draft` is the text being typed in place: remote edits never replace it.
 * - While a shape is dragged or resized here, remote positions and sizes are confirmed but not shown.
 * - Shapes share the notes' stacking space (z); the kind never changes.
 */

export interface BoardShape {
  shape: Shape;
  confirmed: Shape | null;
  /** Set while an add is waiting for its server id. */
  clientRef: string | null;
  draft: string | null;
  dragging: boolean;
  resizing: boolean;
}

export const isShapeHeld = (entry: BoardShape) => entry.dragging || entry.resizing;

export function findShape(board: Board, id: string): BoardShape | undefined {
  return board.shapes.find((s) => s.shape.id === id);
}

const confirmedEntry = (shape: Shape, draft: string | null = null): BoardShape => ({ shape, confirmed: shape, clientRef: null, draft, dragging: false, resizing: false });
const isStale = (entry: BoardShape | undefined, rev: number) => entry?.confirmed != null && rev < entry.confirmed.rev;
const rectOf = (r: NoteRect): NoteRect => ({ x: r.x, y: r.y, w: r.w, h: r.h });

function patch(board: Board, id: string, change: (entry: BoardShape) => BoardShape): Board {
  const index = board.shapes.findIndex((s) => s.shape.id === id);
  const entry = board.shapes[index];
  if (!entry) return board;
  const next = change(entry);
  if (next === entry) return board;
  const shapes = [...board.shapes];
  shapes[index] = next;
  return { ...board, shapes };
}

/* ── From the server ────────────────────────────────────────────────── */

/**
 * The shapes after joining (sent right after the frames snapshot). Authoritative for confirmed
 * shapes, merged by rev: a shape already here at a newer rev keeps it, and shapes being added
 * here (no server id yet) stay.
 */
export function applyShapesSnapshot(board: Board, shapes: readonly Shape[]): Board {
  const merged = shapes.map((shape) => {
    const existing = findShape(board, shape.id);
    return existing && isStale(existing, shape.rev) ? existing : confirmedEntry(shape, existing?.draft ?? null);
  });
  const pending = board.shapes.filter((s) => s.clientRef !== null);
  return { ...board, shapes: [...pending, ...merged], shapesRemoved: [] };
}

/** The shapes snapshot after a reconnect: it replaces every shape; text being typed stays on a shape that is still there. */
export function resyncShapes(board: Board, shapes: readonly Shape[]): Board {
  const drafts = new Map(board.shapes.filter((s) => s.draft !== null).map((s) => [s.shape.id, s.draft] as const));
  return { ...board, shapes: shapes.map((shape) => confirmedEntry(shape, drafts.get(shape.id) ?? null)), shapesRemoved: [] };
}

/** A new shape. With our clientRef, it replaces the temporary one in place (keeping text and style set meanwhile). */
export function applyShapeAdded(board: Board, shape: Shape, clientRef?: string): Board {
  if (clientRef !== undefined) {
    const temp = findShape(board, localId(clientRef));
    if (temp) {
      return patch(board, temp.shape.id, (e) => ({ ...e, shape: { ...shape, ...editableFields(e.shape) }, confirmed: shape, clientRef: null }));
    }
  }
  if (findShape(board, shape.id)) return applyShapeUpdated(board, shape);
  return { ...board, shapes: [...board.shapes, confirmedEntry(shape)] };
}

/** Text or style changed (the whole shape). Unknown shapes are added (a message before the snapshot). */
export function applyShapeUpdated(board: Board, shape: Shape): Board {
  const removed = board.shapesRemoved.find((s) => s.shape.id === shape.id);
  if (removed) {
    if (isStale(removed, shape.rev)) return board;
    return { ...board, shapesRemoved: board.shapesRemoved.map((s) => (s === removed ? { ...s, confirmed: shape } : s)) };
  }
  const entry = findShape(board, shape.id);
  if (!entry) return { ...board, shapes: [...board.shapes, confirmedEntry(shape)] };
  if (isStale(entry, shape.rev)) return board;
  return patch(board, shape.id, (e) => ({ ...e, confirmed: shape, shape: isShapeHeld(e) ? { ...shape, ...rectOf(e.shape) } : shape }));
}

export function applyShapeMoved(board: Board, move: { id: string; x: number; y: number; rev: number; final: boolean }): Board {
  const entry = findShape(board, move.id);
  if (!entry || isStale(entry, move.rev)) return board;
  return patch(board, move.id, (e) => {
    const confirmed = move.final && e.confirmed ? { ...e.confirmed, x: move.x, y: move.y, rev: move.rev } : e.confirmed;
    const position = isShapeHeld(e) ? { x: e.shape.x, y: e.shape.y } : { x: move.x, y: move.y };
    return { ...e, confirmed, shape: { ...e.shape, ...position, rev: Math.max(e.shape.rev, move.rev) } };
  });
}

export function applyShapeResized(board: Board, resize: NoteRect & { id: string; rev: number; final: boolean }): Board {
  const entry = findShape(board, resize.id);
  if (!entry || isStale(entry, resize.rev)) return board;
  return patch(board, resize.id, (e) => {
    const rect = rectOf(resize);
    const confirmed = resize.final && e.confirmed ? { ...e.confirmed, ...rect, rev: resize.rev } : e.confirmed;
    return { ...e, confirmed, shape: { ...e.shape, ...(isShapeHeld(e) ? rectOf(e.shape) : rect), rev: Math.max(e.shape.rev, resize.rev) } };
  });
}

export function applyShapeDeleted(board: Board, id: string): Board {
  if (!findShape(board, id) && !board.shapesRemoved.some((s) => s.shape.id === id)) return board;
  return { ...board, shapes: board.shapes.filter((s) => s.shape.id !== id), shapesRemoved: board.shapesRemoved.filter((s) => s.shape.id !== id) };
}

/** The server refused an add: remove the temporary shape. */
export function rejectShapeAdd(board: Board, clientRef: string): Board {
  const id = localId(clientRef);
  if (!findShape(board, id)) return board;
  return { ...board, shapes: board.shapes.filter((s) => s.shape.id !== id) };
}

/** The server refused a change to `id`: back to what it last confirmed (a refused delete comes back). */
export function rollbackShape(board: Board, id: string): Board {
  const removed = board.shapesRemoved.find((s) => s.shape.id === id);
  if (removed) {
    const { index, ...entry } = removed;
    const shapes = [...board.shapes];
    shapes.splice(Math.min(index, shapes.length), 0, entry.confirmed ? { ...entry, shape: entry.confirmed } : entry);
    return { ...board, shapes, shapesRemoved: board.shapesRemoved.filter((s) => s !== removed) };
  }
  return patch(board, id, (e) => (e.confirmed ? { ...e, shape: e.confirmed, dragging: false, resizing: false } : e));
}

/* ── Local, optimistic ─────────────────────────────────────────────── */

/** A new shape of a kind at a position, with its kind's size and style and no text, on top. */
export function addShapeLocal(board: Board, add: { clientRef: string; kind: ShapeKind; x: number; y: number; authorId: string }): Board {
  const { w, h, ...style } = shapeDefaults(add.kind);
  const shape: Shape = {
    id: localId(add.clientRef),
    kind: add.kind,
    ...clampShapeRect({ x: add.x, y: add.y, w, h }),
    text: "",
    ...style,
    z: topZ(board),
    rev: 1,
    authorId: add.authorId,
  };
  return withPending(board, shape, add.clientRef);
}

/** A shape with its full content (an itemsAdd entry, text already cleaned), clamped as the server will; its ref stands in for a clientRef. */
export function addShapeItemLocal(board: Board, item: ShapeItem, authorId: string): Board {
  const { ref, rank: _, x, y, w, h, ...content } = item;
  return withPending(board, { id: localId(ref), ...content, ...clampShapeRect({ x, y, w, h }), z: topZ(board), rev: 1, authorId }, ref);
}

function withPending(board: Board, shape: Shape, clientRef: string): Board {
  return { ...board, shapes: [...board.shapes, { shape, confirmed: null, clientRef, draft: null, dragging: false, resizing: false }] };
}

/** What a shapeEdit may change: the text and every style field. */
export type ShapeEdit = Partial<Pick<Shape, ShapeEditField>>;

/** A shape's editable fields (SHAPE_EDIT_FIELDS). */
export function editableFields(shape: Shape): Pick<Shape, ShapeEditField> {
  return Object.fromEntries(SHAPE_EDIT_FIELDS.map((f) => [f, shape[f]])) as Pick<Shape, ShapeEditField>;
}

/** The fields of `after` that differ from `before`: what a shapeEdit should carry. */
export function shapeChanges(before: Shape, after: Shape): ShapeEdit {
  return Object.fromEntries(SHAPE_EDIT_FIELDS.filter((f) => after[f] !== before[f]).map((f) => [f, after[f]])) as ShapeEdit;
}

/** A committed text or style, shown at once; text ends the draft. The same board when nothing changes. */
export function editShapeLocal(board: Board, id: string, change: ShapeEdit): Board {
  return patch(board, id, (e) => {
    const defined = Object.fromEntries(Object.entries(change).filter(([, v]) => v !== undefined)) as ShapeEdit;
    const shape = { ...e.shape, ...defined };
    const draft = change.text !== undefined ? null : e.draft;
    if (Object.keys(shapeChanges(e.shape, shape)).length === 0 && draft === e.draft) return e;
    return { ...e, shape, draft };
  });
}

/** The text being typed (null: editing ended). */
export function setShapeDraft(board: Board, id: string, draft: string | null): Board {
  return patch(board, id, (e) => (e.draft === draft ? e : { ...e, draft }));
}

/** Moves a shape, clamped at its own size. */
export function moveShapeLocal(board: Board, id: string, x: number, y: number): Board {
  return patch(board, id, (e) => {
    const p = clampShapePosition(x, y, e.shape);
    return p.x === e.shape.x && p.y === e.shape.y ? e : { ...e, shape: { ...e.shape, ...p } };
  });
}

/** Resizes a shape (position and size together), clamped: size within the shape limits, then on the board. */
export function resizeShapeLocal(board: Board, id: string, rect: NoteRect): Board {
  return patch(board, id, (e) => {
    const r = clampShapeRect(rect);
    const s = e.shape;
    return s.x === r.x && s.y === r.y && s.w === r.w && s.h === r.h ? e : { ...e, shape: { ...s, ...r } };
  });
}

export function setShapeDragging(board: Board, id: string, dragging: boolean): Board {
  return patch(board, id, (e) => (e.dragging === dragging ? e : { ...e, dragging }));
}

export function setShapeResizing(board: Board, id: string, resizing: boolean): Board {
  return patch(board, id, (e) => (e.resizing === resizing ? e : { ...e, resizing }));
}

export function deleteShapeLocal(board: Board, id: string): Board {
  const index = board.shapes.findIndex((s) => s.shape.id === id);
  const entry = board.shapes[index];
  if (!entry) return board;
  return {
    ...board,
    shapes: board.shapes.filter((s) => s !== entry),
    shapesRemoved: [...board.shapesRemoved, { ...entry, dragging: false, resizing: false, index }],
  };
}

/** Back to what the relay last confirmed (a dropped connection): adds go, deletes come back, local changes undone; drafts stay. */
export function discardUnconfirmedShapes(board: Board): Board {
  let next = board;
  for (const removed of [...board.shapesRemoved].reverse()) next = rollbackShape(next, removed.shape.id);
  const shapes = next.shapes.flatMap((entry): BoardShape[] => {
    if (entry.confirmed === null) return [];
    if (entry.shape === entry.confirmed && !entry.dragging && !entry.resizing) return [entry];
    return [{ ...entry, shape: entry.confirmed, dragging: false, resizing: false }];
  });
  return { ...next, shapes, shapesRemoved: [] };
}
