import { z } from "zod";
import {
  CONNECTOR_ANCHORS,
  GROUP_COLORS,
  MAX_CONNECTORS_PER_ROOM,
  MAX_FRAME_TITLE,
  MAX_FRAMES_PER_ROOM,
  MAX_GROUP_LABEL,
  MAX_GROUP_MEMBERS,
  MAX_GROUPS_PER_ROOM,
  MAX_NOTE_TEXT,
  MAX_NOTES_PER_ROOM,
  MAX_SHAPE_TEXT,
  MAX_SHAPES_PER_ROOM,
  MIN_GROUP_MEMBERS,
  anchorPoint,
  clampConnectorPoint,
  clampFrameRect,
  clampNoteRect,
  clampShapeRect,
  cleanFrameTitle,
  cleanGroupLabel,
  cleanNoteText,
  cleanShapeText,
  connectorAddSchema,
  endReference,
  frameItemSchema,
  isBound,
  itemRefSchema,
  noteItemSchema,
  shapeItemSchema,
  truncateCodePoints,
  type ConnectorAnchor,
  type ConnectorStyle,
  type FrameItem,
  type GroupColor,
  type NoteItem,
  type ShapeItem,
} from "@stickyard/shared";
import { findFrame, type BoardFrame } from "../frames/board";
import { findNote, type Board } from "../notes/board";
import { findShape } from "../shapes/board";
import { boxOfBoard } from "../connectors/geometry";

/*
 * Stencils (v0.39.0, web only): small areas to drop onto the board, built in or saved from a
 * selection in this browser. The template format (templates/registry.ts: board units, top-left
 * at 0, 0) extended to carry notes, shapes and frames as the add messages' items (each with a
 * ref), and arrows and groups that name those items by ref. Nothing here is trusted when it comes
 * back from storage: parseStencil validates and clamps every field, and placing one goes through
 * the normal add messages, so the relay validates it again.
 */

export const STENCIL_LIMITS = {
  /** Saved stencils in this browser. */
  count: 20,
  /** One saved stencil, as stored (UTF-8 bytes of its JSON). */
  bytes: 24 * 1024,
  /** Every saved stencil together. */
  totalBytes: 200 * 1024,
  /** A stencil's name, in characters. */
  name: 40,
} as const;

export type StencilNote = Omit<NoteItem, "rank">;
export type StencilShape = Omit<ShapeItem, "rank">;
export type StencilFrame = FrameItem;
/** An arrow's end: on a stencil item (by ref) with an anchor, or a free point. */
export type StencilEnd = { ref: string; anchor: ConnectorAnchor } | { x: number; y: number };
export type StencilArrow = { start: StencilEnd; end: StencilEnd } & ConnectorStyle;
export interface StencilGroup {
  label: string;
  color: GroupColor;
  /** Refs of the stencil's notes and shapes. */
  members: string[];
}

export interface Stencil {
  /** A built-in's fixed id, or a saved one's random id (rename and delete find it by this). */
  id: string;
  /** At most 40 characters, one line. */
  name: string;
  notes: StencilNote[];
  shapes: StencilShape[];
  frames: StencilFrame[];
  arrows: StencilArrow[];
  groups: StencilGroup[];
}

export const UNTITLED_STENCIL = "Untitled stencil";

/** A name as kept: one line, cleaned, at most 40 characters (empty: "Untitled stencil"). */
export function cleanStencilName(raw: string): string {
  return cleanGroupLabel(truncateCodePoints(raw.replace(/\s+/g, " ").trim(), STENCIL_LIMITS.name)) || UNTITLED_STENCIL;
}

const idSchema = z.string().regex(/^[A-Za-z0-9_-]{1,32}$/);
const anchorSchema = z.enum(CONNECTOR_ANCHORS);
const styleSchema = connectorAddSchema.pick({ route: true, dash: true, width: true, ink: true, startHead: true, endHead: true });
const groupColorSchema = z.enum(GROUP_COLORS);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** An item's rect clamped, its text cut to `max` and cleaned; null if the rect isn't numbers or the text isn't a string. */
function clampItem(raw: unknown, textKey: "text" | "title", max: number, clean: (s: string) => string | null, clamp: (r: { x: number; y: number; w: number; h: number }) => { x: number; y: number; w: number; h: number }) {
  if (!isRecord(raw)) return null;
  const { x, y, w, h } = raw;
  const text = raw[textKey];
  if (!finite(x) || !finite(y) || !finite(w) || !finite(h) || typeof text !== "string") return null;
  return { ...raw, ...clamp({ x, y, w, h }), [textKey]: clean(truncateCodePoints(text, max)) ?? "" };
}

function parseEnd(raw: unknown, refs: ReadonlySet<string>): StencilEnd | null {
  if (!isRecord(raw)) return null;
  if ("ref" in raw) {
    const keys = Object.keys(raw);
    const anchor = anchorSchema.safeParse(raw.anchor);
    if (keys.length !== 2 || typeof raw.ref !== "string" || !refs.has(raw.ref) || !anchor.success) return null;
    return { ref: raw.ref, anchor: anchor.data };
  }
  if (Object.keys(raw).length !== 2 || !finite(raw.x) || !finite(raw.y)) return null;
  return clampConnectorPoint(raw.x, raw.y);
}

/**
 * A stencil from untrusted data (storage, or a built-in run through the same check), or null when
 * anything doesn't fit: unknown or missing keys, non-numbers, keys outside the protocol's lists, a
 * ref used twice or naming nothing, a group of fewer than 2 or more than 100, an item in two
 * groups, more than a room holds, or nothing at all. Rects are clamped onto the board and text cut
 * to its cap and cleaned (as the relay would), so a hand-edited size doesn't throw a stencil away.
 */
export function parseStencil(raw: unknown): Stencil | null {
  if (!isRecord(raw)) return null;
  const keys = Object.keys(raw).sort().join(",");
  if (keys !== "arrows,frames,groups,id,name,notes,shapes") return null;
  const { id, name, notes, shapes, frames, arrows, groups } = raw;
  if (!idSchema.safeParse(id).success || typeof name !== "string") return null;
  if (![notes, shapes, frames, arrows, groups].every(Array.isArray)) return null;
  const list = (v: unknown) => v as unknown[];
  if (list(notes).length > MAX_NOTES_PER_ROOM || list(shapes).length > MAX_SHAPES_PER_ROOM || list(frames).length > MAX_FRAMES_PER_ROOM) return null;
  if (list(arrows).length > MAX_CONNECTORS_PER_ROOM || list(groups).length > MAX_GROUPS_PER_ROOM) return null;
  if (list(notes).length + list(shapes).length + list(frames).length === 0) return null;

  const outNotes: StencilNote[] = [];
  for (const n of list(notes)) {
    const item = noteItemSchema.omit({ rank: true }).safeParse(clampItem(n, "text", MAX_NOTE_TEXT, cleanNoteText, clampNoteRect));
    if (!item.success) return null;
    outNotes.push(item.data);
  }
  const outShapes: StencilShape[] = [];
  for (const s of list(shapes)) {
    const item = shapeItemSchema.omit({ rank: true }).safeParse(clampItem(s, "text", MAX_SHAPE_TEXT, cleanShapeText, clampShapeRect));
    if (!item.success) return null;
    outShapes.push(item.data);
  }
  const outFrames: StencilFrame[] = [];
  for (const f of list(frames)) {
    const item = frameItemSchema.safeParse(clampItem(f, "title", MAX_FRAME_TITLE, cleanFrameTitle, clampFrameRect));
    if (!item.success) return null;
    outFrames.push(item.data);
  }
  const allRefs = [...outNotes, ...outShapes, ...outFrames].map((i) => i.ref);
  if (new Set(allRefs).size !== allRefs.length || !allRefs.every((r) => itemRefSchema.safeParse(r).success)) return null;
  const bindable = new Set([...outNotes, ...outShapes].map((i) => i.ref));

  const outArrows: StencilArrow[] = [];
  for (const a of list(arrows)) {
    if (!isRecord(a)) return null;
    const { start, end, ...style } = a;
    const s = parseEnd(start, bindable);
    const e = parseEnd(end, bindable);
    const st = styleSchema.strict().safeParse(style);
    if (!s || !e || !st.success) return null;
    if ("ref" in s && "ref" in e && s.ref === e.ref) return null;
    outArrows.push({ start: s, end: e, ...st.data });
  }

  const outGroups: StencilGroup[] = [];
  const grouped = new Set<string>();
  for (const g of list(groups)) {
    if (!isRecord(g) || Object.keys(g).sort().join(",") !== "color,label,members") return null;
    const color = groupColorSchema.safeParse(g.color);
    if (typeof g.label !== "string" || !color.success || !Array.isArray(g.members)) return null;
    const members = g.members;
    if (members.length < MIN_GROUP_MEMBERS || members.length > MAX_GROUP_MEMBERS) return null;
    if (!members.every((m): m is string => typeof m === "string" && bindable.has(m) && !grouped.has(m))) return null;
    if (new Set(members).size !== members.length) return null;
    for (const m of members) grouped.add(m);
    outGroups.push({ label: cleanGroupLabel(truncateCodePoints(g.label, MAX_GROUP_LABEL)) ?? "", color: color.data, members: [...members] });
  }

  return { id: id as string, name: cleanStencilName(name), notes: outNotes, shapes: outShapes, frames: outFrames, arrows: outArrows, groups: outGroups };
}

export function stencilCounts(s: Stencil): { notes: number; shapes: number; frames: number; arrows: number; groups: number } {
  return { notes: s.notes.length, shapes: s.shapes.length, frames: s.frames.length, arrows: s.arrows.length, groups: s.groups.length };
}

/** The stencil's size: every item and every free arrow point (its top-left is 0, 0). */
export function stencilBounds(s: Stencil): { width: number; height: number } {
  const rects = [...s.notes, ...s.shapes, ...s.frames];
  const points = s.arrows.flatMap((a) => [a.start, a.end].flatMap((e) => ("x" in e ? [e] : [])));
  return {
    width: Math.max(0, ...rects.map((r) => r.x + r.w), ...points.map((p) => p.x)),
    height: Math.max(0, ...rects.map((r) => r.y + r.h), ...points.map((p) => p.y)),
  };
}

/** What a selection is: ids of each kind. */
export interface StencilSelection {
  notes: readonly string[];
  shapes: readonly string[];
  frames: readonly string[];
  connectors: readonly string[];
}

/**
 * Save as stencil: the selected notes, shapes and frames (content and style, text included), the
 * arrows that are selected or join two selected items, and the groups whose every member is
 * selected. An arrow end on anything outside the selection becomes free at its last point. Places
 * are kept, from the selection's top-left. Refs are n1, s1, f1... in board order.
 */
export function buildStencil(board: Board, sel: StencilSelection, name: string, id: string): Stencil {
  const notes = sel.notes.flatMap((nid) => findNote(board, nid)?.note ?? []);
  const shapes = sel.shapes.flatMap((sid) => findShape(board, sid)?.shape ?? []);
  const frames = sel.frames.flatMap((fid) => (findFrame(board, fid) as BoardFrame | undefined)?.frame ?? []);
  const refOf = new Map<string, string>();
  notes.forEach((n, i) => refOf.set(n.id, `n${i + 1}`));
  shapes.forEach((s, i) => refOf.set(s.id, `s${i + 1}`));
  const boxOf = boxOfBoard(board);
  const selectedArrows = new Set(sel.connectors);
  const arrows = board.connectors.flatMap(({ connector: c }) => {
    const inside = (e: typeof c.start) => isBound(e) && refOf.has(e.item);
    if (!selectedArrows.has(c.id) && !(inside(c.start) && inside(c.end))) return [];
    const end = (e: typeof c.start, other: typeof c.start): StencilEnd => {
      if (isBound(e) && refOf.has(e.item)) return { ref: refOf.get(e.item)!, anchor: e.anchor };
      if (!isBound(e)) return { x: e.x, y: e.y };
      const box = boxOf(e.item);
      const p = box ? anchorPoint(box, e.anchor, endReference(other, boxOf) ?? { x: 0, y: 0 }) : { x: 0, y: 0 };
      return clampConnectorPoint(p.x, p.y);
    };
    const { route, dash, width, ink, startHead, endHead } = c;
    return [{ start: end(c.start, c.end), end: end(c.end, c.start), route, dash, width, ink, startHead, endHead }];
  });
  const rects = [...notes, ...shapes, ...frames];
  const points = arrows.flatMap((a) => [a.start, a.end].flatMap((e) => ("x" in e ? [e] : [])));
  const left = Math.min(...rects.map((r) => r.x), ...points.map((p) => p.x));
  const top = Math.min(...rects.map((r) => r.y), ...points.map((p) => p.y));
  const dx = Number.isFinite(left) ? left : 0;
  const dy = Number.isFinite(top) ? top : 0;
  const shift = <T extends { x: number; y: number }>(r: T): T => ({ ...r, x: r.x - dx, y: r.y - dy });
  return {
    id,
    name: cleanStencilName(name),
    notes: notes.map((n, i) => {
      // Relay state (ids, z, rev, author and, since protocol v23, placed) never goes in a stencil.
      const { id: _, z: __, rev: ___, authorId: ____, placed: _____, ...content } = n;
      return shift({ ref: `n${i + 1}`, ...content });
    }),
    shapes: shapes.map((s, i) => {
      const { id: _, z: __, rev: ___, authorId: ____, placed: _____, ...content } = s;
      return shift({ ref: `s${i + 1}`, ...content });
    }),
    frames: frames.map((f, i) => {
      const { id: _, rev: __, authorId: ___, placed: ____, ...content } = f;
      return shift({ ref: `f${i + 1}`, ...content });
    }),
    arrows: arrows.map((a) => ({ ...a, start: "x" in a.start ? shift(a.start) : a.start, end: "x" in a.end ? shift(a.end) : a.end })),
    groups: board.groups.flatMap(({ group: g }) =>
      g.members.length >= MIN_GROUP_MEMBERS && g.members.every((m) => refOf.has(m)) ? [{ label: g.label, color: g.color, members: g.members.map((m) => refOf.get(m)!) }] : [],
    ),
  };
}
