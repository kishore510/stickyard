// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { NOTE_DEFAULTS, NOTE_MAX_W, shapeDefaults, type Connector, type Group, type Note, type Shape } from "@stickyard/shared";
import { EMPTY_BOARD, applySnapshot } from "../src/notes/board";
import { applyShapesSnapshot } from "../src/shapes/board";
import { applyConnectorsSnapshot } from "../src/connectors/board";
import { applyGroupsSnapshot } from "../src/groups/board";
import { BUILTIN_STENCILS } from "../src/stencils/builtins";
import { STENCIL_LIMITS, buildStencil, parseStencil, stencilBounds, stencilCounts, type Stencil } from "../src/stencils/data";
import { STENCIL_TEXT, deleteAllStencils, deleteStencil, loadStencils, renameStencil, saveStencil } from "../src/stencils/storage";
import { STORAGE_KEYS, type KeyValueStore } from "../src/storage";

/*
 * Stencils part 3 (web only): the stencil format (the template format extended with notes,
 * shapes, arrows and groups by reference), parsing what's stored as untrusted (validated, clamped,
 * a malformed, oversized or hostile entry ignored and reported), the built-ins, the caps, storage
 * blocked, and Save as stencil from a selection.
 */

const HOSTILE = "<img src=x onerror=alert(1)>";

/** An in-memory store, optionally blocked (every call throws). */
function memory(blocked = false): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  const guard = () => {
    if (blocked) throw new Error("blocked");
  };
  return {
    data,
    getItem: (k) => (guard(), data.get(k) ?? null),
    setItem: (k, v) => (guard(), void data.set(k, v)),
    removeItem: (k) => (guard(), void data.delete(k)),
  };
}

const valid = (extra: Partial<Stencil> = {}): Stencil => ({
  id: "mine1",
  name: "Mine",
  notes: [{ ref: "n1", x: 0, y: 0, text: "One", ...NOTE_DEFAULTS, color: "yellow" }, { ref: "n2", x: 200, y: 0, text: "Two", ...NOTE_DEFAULTS, color: "blue" }],
  shapes: [],
  frames: [],
  arrows: [{ start: { ref: "n1", anchor: "right" }, end: { ref: "n2", anchor: "left" }, route: "straight", dash: "solid", width: "medium", ink: "neutral", startHead: "none", endHead: "arrow" }],
  groups: [{ label: "Pair", color: "blue", members: ["n1", "n2"] }],
  ...extra,
});

describe("parsing a stencil (untrusted)", () => {
  it("accepts a valid stencil and keeps every field", () => {
    expect(parseStencil(valid())).toEqual(valid());
  });

  it("clamps sizes and positions and cuts long text, instead of refusing", () => {
    const raw = valid({ notes: [{ ...valid().notes[0]!, x: -50, w: 99_999, text: "x".repeat(400) }, valid().notes[1]!] });
    const s = parseStencil(raw)!;
    expect(s.notes[0]).toMatchObject({ x: 0, w: NOTE_MAX_W });
    expect([...s.notes[0]!.text]).toHaveLength(280);
  });

  it.each([
    ["not an object", 42],
    ["a bad colour key", valid({ notes: [{ ...valid().notes[0]!, color: "red; background:url(x)" as never }, valid().notes[1]!] })],
    ["an arrow to an unknown ref", valid({ arrows: [{ ...valid().arrows[0]!, end: { ref: "nope", anchor: "auto" } }] })],
    ["a group of one", valid({ groups: [{ label: "", color: "blue", members: ["n1"] }] })],
    ["an item in two groups", valid({ groups: [{ label: "", color: "blue", members: ["n1", "n2"] }, { label: "", color: "pink", members: ["n1", "n2"] }] })],
    ["a duplicate ref", valid({ notes: [valid().notes[0]!, { ...valid().notes[1]!, ref: "n1" }] })],
    ["a non-number coordinate", valid({ notes: [{ ...valid().notes[0]!, x: "0" as never }, valid().notes[1]!] })],
    ["extra keys", { ...valid(), script: "alert(1)" }],
    ["nothing in it", valid({ notes: [], arrows: [], groups: [] })],
  ])("refuses %s", (_, raw) => {
    expect(parseStencil(raw)).toBeNull();
  });

  it("a hostile name and note text stay plain strings (never markup), names cut to 40", () => {
    const s = parseStencil(valid({ name: `${HOSTILE}${"y".repeat(40)}`, notes: [{ ...valid().notes[0]!, text: HOSTILE }, valid().notes[1]!] }))!;
    expect(s.name.startsWith(HOSTILE)).toBe(true);
    expect([...s.name]).toHaveLength(STENCIL_LIMITS.name);
    expect(s.notes[0]!.text).toBe(HOSTILE);
  });
});

describe("built-in stencils", () => {
  it("there are 4 to 6, each valid through the same parser, generic, and the ones the slice asks for", () => {
    expect(BUILTIN_STENCILS.length).toBeGreaterThanOrEqual(4);
    expect(BUILTIN_STENCILS.length).toBeLessThanOrEqual(6);
    for (const s of BUILTIN_STENCILS) expect(parseStencil(s), s.id).toEqual(s);
    const counts = BUILTIN_STENCILS.map(stencilCounts);
    // A labelled frame with three blank notes; a three-step flow of shapes joined by arrows; four notes in a group.
    expect(counts).toContainEqual({ notes: 3, shapes: 0, frames: 1, arrows: 0, groups: 0 });
    expect(counts).toContainEqual({ notes: 0, shapes: 3, frames: 0, arrows: 2, groups: 0 });
    expect(counts).toContainEqual({ notes: 4, shapes: 0, frames: 0, arrows: 0, groups: 1 });
    expect(BUILTIN_STENCILS.some((s) => { const c = stencilCounts(s); return c.frames + c.shapes > 0 && c.notes > 0 && c.arrows + c.groups > 0; })).toBe(true);
    expect(BUILTIN_STENCILS.find((s) => stencilCounts(s).frames === 1 && stencilCounts(s).notes === 3)?.notes.every((n) => n.text === "")).toBe(true);
  });

  it("each fits on the board with its top-left at 0, 0", () => {
    for (const s of BUILTIN_STENCILS) {
      const b = stencilBounds(s);
      expect(b.width).toBeGreaterThan(0);
      expect(b.width).toBeLessThan(6400);
      expect(b.height).toBeLessThan(4000);
    }
  });
});

describe("storage (this browser only)", () => {
  it("saves, reads back, renames and deletes, under the prefixed key with a version", () => {
    const store = memory();
    expect(saveStencil(valid(), store)).toEqual({ ok: true });
    const raw = JSON.parse(store.data.get(STORAGE_KEYS.stencils)!) as { version: number };
    expect(STORAGE_KEYS.stencils).toBe("stickyard:stencils");
    expect(raw.version).toBe(1);
    expect(loadStencils(store)).toEqual({ stencils: [valid()], malformed: 0, blocked: false });
    renameStencil("mine1", "  Renamed\n", store);
    expect(loadStencils(store).stencils[0]?.name).toBe("Renamed");
    saveStencil(valid({ id: "mine2" }), store);
    deleteStencil("mine1", store);
    expect(loadStencils(store).stencils.map((s) => s.id)).toEqual(["mine2"]);
    deleteAllStencils(store);
    expect(loadStencils(store).stencils).toEqual([]);
  });

  it("a malformed, an oversized and a hostile stored entry are ignored and reported; the good ones load", () => {
    const store = memory();
    const big = valid({ id: "big", notes: Array.from({ length: 150 }, (_, i) => ({ ...valid().notes[0]!, ref: `n${i}`, text: "z".repeat(270) })), arrows: [], groups: [] });
    store.data.set(
      STORAGE_KEYS.stencils,
      JSON.stringify({ version: 1, stencils: [valid(), { id: "bad", name: 3 }, big, { ...valid({ id: "evil" }), notes: [{ ...valid().notes[0]!, color: HOSTILE }, valid().notes[1]] }] }),
    );
    const loaded = loadStencils(store);
    expect(loaded.stencils.map((s) => s.id)).toEqual(["mine1"]);
    expect(loaded.malformed).toBe(3);
    expect(STENCIL_TEXT.malformed(3)).toMatch(/3 saved stencils couldn’t be read/);
    // Not JSON at all: nothing loads, it's reported, nothing throws.
    store.data.set(STORAGE_KEYS.stencils, "{nope");
    expect(loadStencils(store)).toMatchObject({ stencils: [], malformed: 1 });
  });

  it("caps: 20 stencils, 24 KB each, 200 KB in all; a refused save says why", () => {
    const store = memory();
    for (let i = 0; i < STENCIL_LIMITS.count; i++) expect(saveStencil(valid({ id: `s${i}` }), store).ok).toBe(true);
    expect(saveStencil(valid({ id: "one-more" }), store)).toEqual({ ok: false, reason: STENCIL_TEXT.full });
    const fresh = memory();
    const big = valid({ id: "big", notes: Array.from({ length: 150 }, (_, i) => ({ ...valid().notes[0]!, ref: `n${i}`, text: "z".repeat(270) })), arrows: [], groups: [] });
    expect(saveStencil(big, fresh)).toEqual({ ok: false, reason: STENCIL_TEXT.tooBig });
    expect(STENCIL_LIMITS).toMatchObject({ count: 20, bytes: 24 * 1024, totalBytes: 200 * 1024, name: 40 });
  });

  it("with storage blocked: nothing throws, the reason says so, and built-ins still parse", () => {
    const store = memory(true);
    expect(loadStencils(store)).toEqual({ stencils: [], malformed: 0, blocked: true });
    expect(saveStencil(valid(), store)).toEqual({ ok: false, reason: STENCIL_TEXT.blocked });
    expect(BUILTIN_STENCILS.length).toBeGreaterThan(0);
  });
});

describe("Save as stencil from a selection", () => {
  const note = (id: string, x: number, y: number, extra: Partial<Note> = {}): Note => ({ id, x, y, ...NOTE_DEFAULTS, text: id, color: "yellow", z: 0, rev: 1, authorId: "A", ...extra });
  const shape = (id: string, x: number, y: number): Shape => ({ id, kind: "rect", x, y, ...shapeDefaults("rect"), text: "S", z: 5, rev: 1, authorId: "A" });
  const arrow = (id: string, start: Connector["start"], end: Connector["end"]): Connector => ({ id, start, end, route: "elbow", dash: "dashed", width: "thick", ink: "pink", startHead: "none", endHead: "arrow", rev: 1, authorId: "A" });
  const group = (id: string, members: string[]): Group => ({ id, label: "Pair", color: "green", members: [...members].sort(), rev: 1 });
  const board = applyGroupsSnapshot(
    applyConnectorsSnapshot(
      applyShapesSnapshot(applySnapshot(EMPTY_BOARD, [note("A1", 1000, 1000, { text: HOSTILE }), note("A2", 1300, 1000), note("OUT", 3000, 3000)]), [shape("S1", 1000, 1300)]),
      [
        arrow("C1", { item: "A1", anchor: "right" }, { item: "A2", anchor: "left" }),
        arrow("C2", { item: "A2", anchor: "auto" }, { item: "OUT", anchor: "auto" }),
        arrow("C3", { item: "A1", anchor: "bottom" }, { item: "OUT", anchor: "top" }),
      ],
    ),
    [group("G1", ["A1", "A2"]), group("G2", ["S1", "OUT"])],
  );

  it("keeps the selected items with their text and style, at their places from the selection's top-left", () => {
    const s = buildStencil(board, { notes: ["A1", "A2"], shapes: ["S1"], frames: [], connectors: [] }, "My area", "id1");
    expect(stencilCounts(s)).toMatchObject({ notes: 2, shapes: 1, frames: 0 });
    expect(s.notes[0]).toMatchObject({ x: 0, y: 0, text: HOSTILE, color: "yellow" });
    expect(s.notes[1]).toMatchObject({ x: 300, y: 0 });
    expect(s.shapes[0]).toMatchObject({ x: 0, y: 300, kind: "rect", text: "S" });
    expect(parseStencil(s)).toEqual(s);
  });

  it("keeps arrows and groups wholly inside the selection; a selected arrow attached outside keeps a free end at its last point", () => {
    const s = buildStencil(board, { notes: ["A1", "A2"], shapes: ["S1"], frames: [], connectors: ["C2"] }, "My area", "id1");
    // C1 joins two selected notes (kept, bound); C2 is selected but ends on OUT (free there); C3 isn't selected and leaves.
    expect(s.arrows).toHaveLength(2);
    const [inside, freed] = s.arrows;
    expect(inside).toMatchObject({ start: { anchor: "right" }, end: { anchor: "left" }, route: "elbow", dash: "dashed", width: "thick", ink: "pink" });
    expect("ref" in freed!.start).toBe(true);
    expect("x" in freed!.end).toBe(true);
    // G1 is wholly inside; G2 has a member outside.
    expect(s.groups).toEqual([{ label: "Pair", color: "green", members: expect.arrayContaining([s.notes[0]!.ref, s.notes[1]!.ref]) }]);
  });
});
