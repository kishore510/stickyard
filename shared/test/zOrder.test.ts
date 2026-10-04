import { describe, expect, it } from "vitest";
import {
  MAX_BATCH_ENTRIES,
  MAX_MESSAGE_BYTES,
  MAX_NOTES_PER_ROOM,
  MAX_SERVER_MESSAGE_BYTES,
  NOTE_DEFAULTS,
  NOTE_Z_LIMIT,
  ORDER_ACTIONS,
  PROTOCOL_VERSION,
  checkOrder,
  clientMessageSchema,
  compareStack,
  encodeMessage,
  parseMessage,
  restack,
  serverMessageSchema,
  stackOrder,
  zForNew,
  type Note,
  type Stacked,
} from "../src/index";

/*
 * Protocol v8 (slice z-order): notes carry a server-assigned z; notesOrder brings notes to the
 * front or sends them to the back. The stacking helpers are shared, so the relay and the page
 * order notes identically. Fixtures are generic.
 */

const id = (i: number) => `note${String(i).padStart(12, "0")}`;
const order = (ids: unknown, action: unknown = "front") => ({ type: "notesOrder", ids, action });
const parses = (message: unknown) => clientMessageSchema.safeParse(message).success;
const note: Note = { id: id(0), x: 1, y: 2, ...NOTE_DEFAULTS, text: "Idea one", color: "yellow", z: 0, rev: 1, authorId: "AAAAAAAAAAAAAAAA" };

/** Ids bottom to top. */
const stack = (items: readonly Stacked[]) => stackOrder(items).map((n) => n.id);
/** Applies changes to items. */
const apply = (items: readonly Stacked[], changes: readonly Stacked[]) => {
  const z = new Map(changes.map((c) => [c.id, c.z]));
  return items.map((n) => ({ id: n.id, z: z.get(n.id) ?? n.z }));
};
const five = (): Stacked[] => [0, 1, 2, 3, 4].map((i) => ({ id: id(i), z: i }));

describe("protocol v8", () => {
  it("z arrived in protocol 8, with a bounded z and two actions", () => {
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(8);
    expect(NOTE_Z_LIMIT).toBe(100_000);
    expect(ORDER_ACTIONS).toEqual(["front", "back"]);
  });

  it("a note carries z: integers within the bound only", () => {
    const ok = (z: unknown) => serverMessageSchema.safeParse({ type: "noteUpdated", note: { ...note, z } }).success;
    expect(ok(0)).toBe(true);
    expect(ok(NOTE_Z_LIMIT)).toBe(true);
    expect(ok(-NOTE_Z_LIMIT)).toBe(true);
    expect(ok(NOTE_Z_LIMIT + 1)).toBe(false);
    expect(ok(-NOTE_Z_LIMIT - 1)).toBe(false);
    expect(ok(1.5)).toBe(false);
    const { z: _z, ...withoutZ } = note;
    expect(serverMessageSchema.safeParse({ type: "noteUpdated", note: withoutZ }).success).toBe(false);
  });

  it("noteAdd never carries z (clients never send one)", () => {
    expect(parses({ type: "noteAdd", clientRef: "r1", x: 1, y: 2, color: "yellow", text: "" })).toBe(true);
    expect(parses({ type: "noteAdd", clientRef: "r1", x: 1, y: 2, color: "yellow", text: "", z: 5 })).toBe(false);
    expect(parses({ type: "noteEdit", id: id(0), z: 5 })).toBe(false);
  });
});

describe("notesOrder schema", () => {
  it("accepts 1 to 50 ids with front or back", () => {
    expect(parses(order([id(0)]))).toBe(true);
    expect(parses(order([id(0)], "back"))).toBe(true);
    expect(parses(order(Array.from({ length: MAX_BATCH_ENTRIES }, (_, i) => id(i))))).toBe(true);
  });

  it("is strict: extra fields, empty ids, over 50 and a bad action are refused", () => {
    expect(parses({ ...order([id(0)]), z: 3 })).toBe(false);
    expect(parses(order([]))).toBe(false);
    expect(parses(order(Array.from({ length: MAX_BATCH_ENTRIES + 1 }, (_, i) => id(i))))).toBe(false);
    expect(parses(order([id(0)], "forward"))).toBe(false);
    expect(parses(order([id(0)], "top"))).toBe(false);
    expect(parses(order(id(0)))).toBe(false);
    expect(parses({ type: "notesOrder", ids: [id(0)] })).toBe(false);
  });

  it("checkOrder: bad ids are reported by index, good ones kept", () => {
    const result = checkOrder([id(0), "not an id", 7, id(1)]);
    expect(result.valid).toEqual([
      { index: 0, id: id(0) },
      { index: 3, id: id(1) },
    ]);
    expect(result.invalid).toEqual([1, 2]);
    expect(result.duplicate).toBe(false);
  });

  it("checkOrder: an id named twice refuses the whole message, naming its notes", () => {
    const result = checkOrder([id(0), id(1), id(0)]);
    expect(result.duplicate).toBe(true);
    expect(result.valid).toEqual([]);
    expect(result.invalid).toEqual([0, 1, 2]);
    expect(result.invalidIds).toEqual([id(0), id(1)]);
  });

  it("the largest notesOrder fits the client message cap", () => {
    const raw = encodeMessage({ type: "notesOrder", ids: Array.from({ length: MAX_BATCH_ENTRIES }, (_, i) => id(i)), action: "front" });
    expect(raw.length).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
    expect(parseMessage(raw, clientMessageSchema).ok).toBe(true);
  });

  it("notesOrdered carries up to every note (a renormalised room), and fits the server cap", () => {
    const results = Array.from({ length: MAX_NOTES_PER_ROOM }, (_, i) => ({ id: id(i), z: -NOTE_Z_LIMIT, rev: Number.MAX_SAFE_INTEGER }));
    const raw = encodeMessage({ type: "notesOrdered", results });
    expect(raw.length).toBeLessThan(MAX_SERVER_MESSAGE_BYTES);
    expect(parseMessage(raw, serverMessageSchema, MAX_SERVER_MESSAGE_BYTES).ok).toBe(true);
    expect(serverMessageSchema.safeParse({ type: "notesOrdered", results: [] }).success).toBe(false);
    expect(serverMessageSchema.safeParse({ type: "notesOrdered", results: [...results, { id: id(999), z: 0, rev: 1 }] }).success).toBe(false);
  });
});

describe("stacking order", () => {
  it("sorts by z, then by id (code unit order), the same everywhere", () => {
    const items = [
      { id: "b", z: 1 },
      { id: "a", z: 1 },
      { id: "c", z: -4 },
    ];
    expect(stack(items)).toEqual(["c", "a", "b"]);
    expect(compareStack({ id: "a", z: 2 }, { id: "b", z: 1 })).toBeGreaterThan(0);
    expect(compareStack({ id: "B", z: 1 }, { id: "a", z: 1 })).toBeLessThan(0);
    expect(compareStack({ id: "a", z: 1 }, { id: "a", z: 1 })).toBe(0);
  });

  it("front: the named notes go above all others, keeping their relative order; others are untouched", () => {
    const items = five();
    const { changes, renormalised } = restack(items, [id(3), id(0)], "front");
    expect(renormalised).toBe(false);
    expect(stack(apply(items, changes))).toEqual([id(1), id(2), id(4), id(0), id(3)]);
    expect(changes.map((c) => c.id).sort()).toEqual([id(0), id(3)]);
  });

  it("back: the named notes go below all others, keeping their relative order", () => {
    const items = five();
    const { changes } = restack(items, [id(4), id(2)], "back");
    expect(stack(apply(items, changes))).toEqual([id(2), id(4), id(0), id(1), id(3)]);
    expect(changes.map((c) => c.id).sort()).toEqual([id(2), id(4)]);
  });

  it("only notes whose z must change are changed: already on top (or bottom) is a no-op", () => {
    const items = five();
    expect(restack(items, [id(4)], "front").changes).toEqual([]);
    expect(restack(items, [id(3), id(4)], "front").changes).toEqual([]);
    expect(restack(items, [id(0)], "back").changes).toEqual([]);
    expect(restack(items, [id(0), id(1)], "back").changes).toEqual([]);
    // Every note named: they already are in their own order.
    expect(restack(items, items.map((n) => n.id), "front").changes).toEqual([]);
    // The top note already above the rest stays put; only the one below moves (into the gap).
    const spaced = items.map((n) => ({ ...n, z: n.z * 10 }));
    expect(restack(spaced, [id(1), id(4)], "front").changes).toEqual([{ id: id(1), z: 31 }]);
    // Without a gap, the one above moves up too: changes never create a tie.
    expect(restack(items, [id(1), id(4)], "front").changes).toEqual([
      { id: id(1), z: 4 },
      { id: id(4), z: 5 },
    ]);
  });

  it("unknown ids are ignored", () => {
    expect(restack(five(), [id(99)], "front").changes).toEqual([]);
    expect(stack(apply(five(), restack(five(), [id(99), id(0)], "front").changes))).toEqual([id(1), id(2), id(3), id(4), id(0)]);
  });

  it("ties in z are broken by id, and front still lands strictly above", () => {
    const items = [
      { id: "a", z: 0 },
      { id: "b", z: 0 },
      { id: "c", z: 0 },
    ];
    expect(restack(items, ["c"], "front").changes).toEqual([]);
    expect(stack(apply(items, restack(items, ["a"], "front").changes))).toEqual(["b", "c", "a"]);
    expect(stack(apply(items, restack(items, ["c"], "back").changes))).toEqual(["c", "a", "b"]);
  });

  it("renormalises the whole room when an action would pass the bound, keeping the result's order", () => {
    const items = [
      { id: id(0), z: -5 },
      { id: id(1), z: 10 },
      { id: id(2), z: NOTE_Z_LIMIT },
    ];
    const front = restack(items, [id(0)], "front");
    expect(front.renormalised).toBe(true);
    const after = apply(items, front.changes);
    expect(stack(after)).toEqual([id(1), id(2), id(0)]);
    expect(after.every((n) => Math.abs(n.z) <= NOTE_Z_LIMIT)).toBe(true);
    expect(after.map((n) => n.z).sort((a, b) => a - b)).toEqual([0, 1, 2]);

    const low = [
      { id: id(0), z: -NOTE_Z_LIMIT },
      { id: id(1), z: 3 },
    ];
    const back = restack(low, [id(1)], "back");
    expect(back.renormalised).toBe(true);
    expect(stack(apply(low, back.changes))).toEqual([id(1), id(0)]);
    // Every changed note is reported (here both).
    expect(back.changes.map((c) => c.id).sort()).toEqual([id(0), id(1)]);
  });

  it("a new note goes on top (max z + 1; 0 on an empty board)", () => {
    expect(zForNew([])).toEqual({ z: 0, changes: [] });
    expect(zForNew(five())).toEqual({ z: 5, changes: [] });
    expect(zForNew([{ id: id(0), z: -7 }])).toEqual({ z: -6, changes: [] });
  });

  it("a new note at the bound renormalises the others first and still goes on top", () => {
    const items = [
      { id: id(0), z: NOTE_Z_LIMIT },
      { id: id(1), z: -3 },
    ];
    const { z, changes } = zForNew(items);
    const after = apply(items, changes);
    expect(stack(after)).toEqual([id(1), id(0)]);
    expect(z).toBeGreaterThan(Math.max(...after.map((n) => n.z)));
    expect(z).toBeLessThanOrEqual(NOTE_Z_LIMIT);
  });

  it("many fronts in a row stay in bounds and keep the latest on top", () => {
    let items: Stacked[] = five();
    for (let n = 0; n < 2 * NOTE_Z_LIMIT + 10; n += 1) {
      const target = id(n % 5);
      items = apply(items, restack(items, [target], "front").changes);
    }
    expect(items.every((i) => Math.abs(i.z) <= NOTE_Z_LIMIT)).toBe(true);
    expect(stack(items).at(-1)).toBe(id((2 * NOTE_Z_LIMIT + 9) % 5));
  });
});
