import { utf8Length } from "@stickyard/shared";
import { STORAGE_KEYS, appStorage, type KeyValueStore } from "../storage";
import { STENCIL_LIMITS, cleanStencilName, parseStencil, type Stencil } from "./data";
import { STENCIL_TEXT } from "./rules";

/*
 * Saved stencils live in this browser only, under one prefixed key (STORAGE_KEYS.stencils) as
 * `{ version: 1, stencils: [...] }`. Every read is untrusted: each entry goes through
 * parseStencil (and the size cap); a malformed or oversized one is left out and counted. Every
 * call is wrapped: storage that's missing, blocked or full never throws, it's reported.
 */

export const STENCIL_STORE_VERSION = 1;

export interface LoadedStencils {
  stencils: Stencil[];
  /** Entries that couldn't be read (malformed, oversized, or the whole value). */
  malformed: number;
  /** Storage is blocked or missing. */
  blocked: boolean;
}

export type SaveResult = { ok: true } | { ok: false; reason: string };

const bytes = (s: Stencil) => utf8Length(JSON.stringify(s));

export function loadStencils(store: KeyValueStore | undefined = appStorage()): LoadedStencils {
  let raw: string | null;
  try {
    if (!store) return { stencils: [], malformed: 0, blocked: true };
    raw = store.getItem(STORAGE_KEYS.stencils);
  } catch {
    return { stencils: [], malformed: 0, blocked: true };
  }
  if (raw === null) return { stencils: [], malformed: 0, blocked: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { stencils: [], malformed: 1, blocked: false };
  }
  const value = parsed as { version?: unknown; stencils?: unknown };
  if (typeof parsed !== "object" || parsed === null || value.version !== STENCIL_STORE_VERSION || !Array.isArray(value.stencils)) {
    return { stencils: [], malformed: 1, blocked: false };
  }
  const stencils: Stencil[] = [];
  let malformed = 0;
  const ids = new Set<string>();
  for (const entry of value.stencils.slice(0, STENCIL_LIMITS.count)) {
    const s = parseStencil(entry);
    if (!s || ids.has(s.id) || bytes(s) > STENCIL_LIMITS.bytes) malformed++;
    else {
      ids.add(s.id);
      stencils.push(s);
    }
  }
  malformed += Math.max(0, value.stencils.length - STENCIL_LIMITS.count);
  return { stencils, malformed, blocked: false };
}

function write(list: readonly Stencil[], store: KeyValueStore | undefined): SaveResult {
  try {
    if (!store) return { ok: false, reason: STENCIL_TEXT.blocked };
    store.setItem(STORAGE_KEYS.stencils, JSON.stringify({ version: STENCIL_STORE_VERSION, stencils: list }));
    return { ok: true };
  } catch {
    return { ok: false, reason: STENCIL_TEXT.blocked };
  }
}

/** Adds a stencil (checked like a stored one), within the caps: 20 stencils, 24 KB each, 200 KB in all. */
export function saveStencil(stencil: Stencil, store: KeyValueStore | undefined = appStorage()): SaveResult {
  const current = loadStencils(store);
  if (current.blocked) return { ok: false, reason: STENCIL_TEXT.blocked };
  const clean = parseStencil(stencil);
  if (!clean) return { ok: false, reason: STENCIL_TEXT.nothingToSave };
  if (current.stencils.length >= STENCIL_LIMITS.count) return { ok: false, reason: STENCIL_TEXT.full };
  if (bytes(clean) > STENCIL_LIMITS.bytes) return { ok: false, reason: STENCIL_TEXT.tooBig };
  const next = [...current.stencils.filter((s) => s.id !== clean.id), clean];
  if (next.reduce((n, s) => n + bytes(s), 0) > STENCIL_LIMITS.totalBytes) return { ok: false, reason: STENCIL_TEXT.totalFull };
  return write(next, store);
}

export function renameStencil(id: string, name: string, store: KeyValueStore | undefined = appStorage()): SaveResult {
  const current = loadStencils(store);
  if (current.blocked) return { ok: false, reason: STENCIL_TEXT.blocked };
  return write(current.stencils.map((s) => (s.id === id ? { ...s, name: cleanStencilName(name) } : s)), store);
}

export function deleteStencil(id: string, store: KeyValueStore | undefined = appStorage()): SaveResult {
  const current = loadStencils(store);
  if (current.blocked) return { ok: false, reason: STENCIL_TEXT.blocked };
  return write(current.stencils.filter((s) => s.id !== id), store);
}

export function deleteAllStencils(store: KeyValueStore | undefined = appStorage()): SaveResult {
  return write([], store);
}

export { STENCIL_TEXT };
