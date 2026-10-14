import { CONNECTOR_STYLE_FIELDS, isBound, type ConnectorEnd } from "@stickyard/shared";
import type { Fields } from "../history/history";
import type { ConnectorContent, ConnectorPatch } from "./board";

/*
 * Arrows in the undo history (web only). The history keeps plain fields (strings, numbers,
 * booleans), so each end is kept as a small JSON string in a fixed key order: {"x":..,"y":..} or
 * {"item":..,"anchor":..}. An item's new id (an undo adding it back, then the relay's id) reaches
 * the ends through renameEndRefs.
 */

export const encodeEnd = (end: ConnectorEnd): string =>
  isBound(end) ? JSON.stringify({ item: end.item, anchor: end.anchor }) : JSON.stringify({ x: end.x, y: end.y });

export const decodeEnd = (value: unknown): ConnectorEnd | null => {
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (typeof parsed.item === "string" && typeof parsed.anchor === "string") return { item: parsed.item, anchor: parsed.anchor } as ConnectorEnd;
    if (typeof parsed.x === "number" && typeof parsed.y === "number") return { x: parsed.x, y: parsed.y };
  } catch {
    // Not an end.
  }
  return null;
};

/** An arrow's content (or part of it) as history fields. */
export function connectorFields(c: ConnectorPatch): Fields {
  const out: Record<string, string> = {};
  if (c.start) out.start = encodeEnd(c.start);
  if (c.end) out.end = encodeEnd(c.end);
  for (const f of CONNECTOR_STYLE_FIELDS) if (c[f] !== undefined) out[f] = c[f];
  return out;
}

/** History fields back to a connectorUpdate's fields (unknown keys left out). */
export function patchFromFields(fields: Fields): ConnectorPatch {
  const out: Record<string, unknown> = {};
  for (const key of ["start", "end"] as const) {
    const end = decodeEnd(fields[key]);
    if (end) out[key] = end;
  }
  for (const f of CONNECTOR_STYLE_FIELDS) if (typeof fields[f] === "string") out[f] = fields[f];
  return out as ConnectorPatch;
}

/** History fields as a whole arrow's content (an undo adding it back), or null if anything is missing. */
export function contentFromFields(fields: Fields): ConnectorContent | null {
  const p = patchFromFields(fields);
  return p.start && p.end && CONNECTOR_STYLE_FIELDS.every((f) => p[f] !== undefined) ? (p as ConnectorContent) : null;
}

/** An item's new id in the ends of some fields; the same object when none names it. */
export function renameEndRefs(fields: Fields, from: string, to: string): Fields {
  let out: Record<string, string | number | boolean> | null = null;
  for (const key of ["start", "end"] as const) {
    const end = decodeEnd(fields[key]);
    if (!end || !isBound(end) || end.item !== from) continue;
    out ??= { ...fields };
    out[key] = encodeEnd({ item: to, anchor: end.anchor });
  }
  return out ?? fields;
}
