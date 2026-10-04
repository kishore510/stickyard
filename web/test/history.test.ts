import { describe, expect, it } from "vitest";
import {
  COALESCE_MS,
  EXPECT_TIMEOUT_MS,
  HISTORY_DEPTH,
  HISTORY_TEXT,
  History,
  type Fields,
  type ItemKind,
  type Plan,
} from "../src/history/history";

/*
 * The undo history (web/src/history/history.ts), pure: no socket, no board. A tiny fake relay
 * below plays the server's part (rev bumps, new ids for restored items) and tells the history
 * what it saw, as RoomSession does.
 */

type Item = { kind: ItemKind; id: string; rev: number; state: Fields };

class FakeRelay {
  items = new Map<string, Item>();
  next = 0;
  constructor(readonly history: History) {}
  key = (kind: ItemKind, id: string) => `${kind}:${id}`;
  get(kind: ItemKind, id: string) {
    return this.items.get(this.key(kind, id));
  }
  put(kind: ItemKind, id: string, state: Fields, rev = 1) {
    this.items.set(this.key(kind, id), { kind, id, rev, state: { ...state } });
  }
  lookup = (kind: ItemKind, id: string) => {
    const item = this.get(kind, id);
    return item ? { rev: item.rev, held: false, state: { ...item.state } } : null;
  };
  /** A stored change: rev + 1, and the history hears it (mine or someone else's, it decides). */
  change(kind: ItemKind, id: string, values: Fields) {
    const item = this.get(kind, id);
    if (!item) throw new Error(`no ${id}`);
    const prev = item.rev;
    const zOnly = Object.keys(values).every((k) => k === "z");
    item.state = { ...item.state, ...values };
    item.rev++;
    this.history.observe(kind, id, prev, item.rev, item.state, zOnly);
  }
  remove(kind: ItemKind, id: string) {
    this.items.delete(this.key(kind, id));
    this.history.deleted(kind, id);
  }
  /** An add of mine (local id) confirmed under a new server id. */
  confirm(kind: ItemKind, localId: string, state: Fields) {
    const id = `srv${this.next++}`;
    this.put(kind, id, state);
    this.history.confirmAdd(kind, localId, id, 1);
    return id;
  }
  /** Runs a plan as the session does: sends everything, then the relay answers. */
  run(plan: Plan, now: number) {
    if (plan.type !== "apply") {
      this.history.applied(plan, new Map(), now);
      return;
    }
    const local = new Map<string, string>();
    for (const r of plan.restores) local.set(this.key(r.kind, r.id), `local:${r.kind}${this.next++}`);
    this.history.applied(plan, local, now);
    for (const c of plan.changes) this.change(c.kind, c.id, c.values);
    for (const d of plan.deletes) this.remove(d.kind, d.id);
    for (const r of plan.restores) this.confirm(r.kind, local.get(this.key(r.kind, r.id))!, { ...r.content, z: r.z });
  }
}

function setup() {
  const history = new History();
  const relay = new FakeRelay(history);
  let now = 1_000;
  const tick = (ms = 1_000) => (now += ms);
  const undo = () => {
    const plan = history.plan("undo", relay.lookup, now);
    relay.run(plan, now);
    return plan;
  };
  const redo = () => {
    const plan = history.plan("redo", relay.lookup, now);
    relay.run(plan, now);
    return plan;
  };
  /** One of my changes: recorded, then stored by the relay. */
  const mine = (label: string, kind: ItemKind, id: string, values: Fields, coalesce?: string) => {
    const before = Object.fromEntries(Object.keys(values).map((k) => [k, relay.get(kind, id)!.state[k]!]));
    history.recordChange(label, [{ kind, id, before, after: values }], now, coalesce);
    relay.change(kind, id, values);
  };
  return { history, relay, tick, undo, redo, mine, now: () => now };
}

const noteState = (x = 10, y = 20, text = "Idea"): Fields => ({ x, y, w: 160, h: 160, text, color: "yellow", bold: false, z: 0 });

describe("the history stacks", () => {
  it("starts empty: nothing to undo or redo", () => {
    const { history, now } = setup();
    expect(history.undoReason(now())).toBe(HISTORY_TEXT.nothingToUndo);
    expect(history.redoReason(now())).toBe(HISTORY_TEXT.nothingToRedo);
    expect(history.plan("undo", () => null, now())).toEqual({ type: "none", reason: HISTORY_TEXT.nothingToUndo });
  });

  it("undo then redo moves an entry across; a new action clears redo", () => {
    const t = setup();
    t.relay.put("note", "a", noteState());
    t.mine("Move", "note", "a", { x: 50, y: 60 });
    expect(t.history.undoReason(t.now())).toBeNull();
    t.tick();
    t.undo();
    expect(t.relay.get("note", "a")!.state).toMatchObject({ x: 10, y: 20 });
    expect(t.history.sizes).toEqual({ undo: 0, redo: 1 });
    t.tick();
    t.redo();
    expect(t.relay.get("note", "a")!.state).toMatchObject({ x: 50, y: 60 });
    t.tick();
    t.undo();
    t.tick();
    t.mine("Edit text", "note", "a", { text: "New" });
    expect(t.history.sizes).toEqual({ undo: 1, redo: 0 });
  });

  it("a change waiting for the relay isn't undoable yet; once heard it is", () => {
    const t = setup();
    t.relay.put("note", "a", noteState());
    t.history.recordChange("Move", [{ kind: "note", id: "a", before: { x: 10, y: 20 }, after: { x: 99, y: 20 } }], t.now());
    expect(t.history.undoReason(t.now())).toBe(HISTORY_TEXT.unsaved);
    t.relay.change("note", "a", { x: 99, y: 20 });
    expect(t.history.undoReason(t.now())).toBeNull();
  });

  it("a change the relay never confirms stops blocking after EXPECT_TIMEOUT_MS (and is dropped)", () => {
    const t = setup();
    t.relay.put("note", "a", noteState());
    t.history.recordChange("Move", [{ kind: "note", id: "a", before: { x: 10, y: 20 }, after: { x: 99, y: 20 } }], t.now());
    t.tick(EXPECT_TIMEOUT_MS + 1);
    expect(t.history.undoReason(t.now())).toBe(HISTORY_TEXT.nothingToUndo);
  });

  it("a refused change is dropped (its entry too when nothing is left)", () => {
    const t = setup();
    t.relay.put("note", "a", noteState());
    t.history.recordChange("Move", [{ kind: "note", id: "a", before: { x: 10, y: 20 }, after: { x: 99, y: 20 } }], t.now());
    t.history.refuse("note", "a");
    expect(t.history.sizes.undo).toBe(0);
  });

  it("clear() empties both stacks (resync, reconnect, leaving)", () => {
    const t = setup();
    t.relay.put("note", "a", noteState());
    t.mine("Move", "note", "a", { x: 50, y: 60 });
    t.mine("Move", "note", "a", { x: 70, y: 60 });
    t.tick();
    t.undo();
    t.history.clear();
    expect(t.history.sizes).toEqual({ undo: 0, redo: 0 });
  });
});

describe("caps", () => {
  it(`keeps the last ${HISTORY_DEPTH} entries`, () => {
    const t = setup();
    t.relay.put("note", "a", noteState());
    for (let i = 1; i <= HISTORY_DEPTH + 10; i++) {
      t.tick();
      t.mine("Edit text", "note", "a", { text: `v${i}` });
    }
    expect(t.history.sizes.undo).toBe(HISTORY_DEPTH);
    for (let i = 0; i < HISTORY_DEPTH; i++) {
      t.tick();
      t.undo();
    }
    // The oldest ten went: the text is back to the 10th version, not the first.
    expect(t.relay.get("note", "a")!.state.text).toBe("v10");
    expect(t.history.undoReason(t.now())).toBe(HISTORY_TEXT.nothingToUndo);
  });

  it("drops the oldest beyond the size cap (estimated content size)", () => {
    const small = new History({ maxBytes: 20_000 });
    const relay = new FakeRelay(small);
    const big = "x".repeat(2_000);
    for (let i = 0; i < 20; i++) {
      relay.put("note", `n${i}`, { ...noteState(), text: big });
      small.recordRemove("Delete", [{ kind: "note", id: `n${i}`, content: { ...noteState(), text: big }, z: 0, rev: 1 }], 1_000 + i);
      relay.remove("note", `n${i}`);
    }
    expect(small.sizes.undo).toBeLessThan(20);
    expect(small.sizes.undo).toBeGreaterThan(0);
    expect(small.bytes).toBeLessThanOrEqual(20_000);
  });
});

describe("coalescing", () => {
  it("moves of the same notes within COALESCE_MS are one entry (arrow-key repeats); later ones are separate", () => {
    const t = setup();
    t.relay.put("note", "a", noteState());
    t.mine("Move", "note", "a", { x: 20, y: 20 }, "move");
    t.tick(COALESCE_MS - 100);
    t.mine("Move", "note", "a", { x: 30, y: 20 }, "move");
    t.tick(COALESCE_MS - 100);
    t.mine("Move", "note", "a", { x: 40, y: 20 }, "move");
    expect(t.history.sizes.undo).toBe(1);
    t.tick(COALESCE_MS + 100);
    t.mine("Move", "note", "a", { x: 50, y: 20 }, "move");
    expect(t.history.sizes.undo).toBe(2);
    t.undo();
    expect(t.relay.get("note", "a")!.state.x).toBe(40);
    t.undo();
    expect(t.relay.get("note", "a")!.state.x).toBe(10);
  });

  it("merging works while the first part is still in flight", () => {
    const t = setup();
    t.relay.put("note", "a", noteState());
    t.history.recordChange("Move", [{ kind: "note", id: "a", before: { x: 10, y: 20 }, after: { x: 20, y: 20 } }], t.now(), "move");
    t.history.recordChange("Move", [{ kind: "note", id: "a", before: { x: 20, y: 20 }, after: { x: 30, y: 20 } }], t.now() + 100, "move");
    t.relay.change("note", "a", { x: 20, y: 20 });
    expect(t.history.undoReason(t.now())).toBe(HISTORY_TEXT.unsaved);
    t.relay.change("note", "a", { x: 30, y: 20 });
    expect(t.history.undoReason(t.now())).toBeNull();
    t.undo();
    expect(t.relay.get("note", "a")!.state.x).toBe(10);
  });

  it("different notes, or a different kind of change, never merge", () => {
    const t = setup();
    t.relay.put("note", "a", noteState());
    t.relay.put("note", "b", noteState());
    t.mine("Move", "note", "a", { x: 20, y: 20 }, "move");
    t.mine("Move", "note", "b", { x: 20, y: 20 }, "move");
    t.mine("Edit text", "note", "b", { text: "B" });
    expect(t.history.sizes.undo).toBe(3);
  });

  it("pendingValues: what my changes still in flight will make a field (so the next one starts there)", () => {
    const t = setup();
    t.relay.put("note", "a", noteState());
    t.history.recordChange("Move", [{ kind: "note", id: "a", before: { x: 10, y: 20 }, after: { x: 20, y: 20 } }], t.now());
    expect(t.history.pendingValues("note", "a")).toEqual({ x: 20, y: 20 });
    t.relay.change("note", "a", { x: 20, y: 20 });
    expect(t.history.pendingValues("note", "a")).toEqual({});
  });
});

/* ── Every action kind: do, undo, redo ──────────────────────────────── */

describe("round trips (do, undo, redo restores the state)", () => {
  const cases: { name: string; kind: ItemKind; start: Fields; values: Fields }[] = [
    { name: "note move", kind: "note", start: noteState(), values: { x: 400, y: 300 } },
    { name: "note resize", kind: "note", start: noteState(), values: { x: 0, y: 0, w: 300, h: 200 } },
    { name: "text edit", kind: "note", start: noteState(), values: { text: "Changed\nbody" } },
    { name: "colour and style", kind: "note", start: noteState(), values: { color: "pink", bold: true } },
    { name: "frame move", kind: "frame", start: { x: 0, y: 0, w: 640, h: 400, title: "T", color: "neutral" }, values: { x: 100, y: 50 } },
    { name: "frame resize", kind: "frame", start: { x: 0, y: 0, w: 640, h: 400, title: "T", color: "neutral" }, values: { w: 900, h: 600 } },
    { name: "frame edit", kind: "frame", start: { x: 0, y: 0, w: 640, h: 400, title: "T", color: "neutral" }, values: { title: "Retro", color: "green" } },
  ];
  it.each(cases)("$name", ({ kind, start, values }) => {
    const t = setup();
    t.relay.put(kind, "a", start);
    t.mine("Change", kind, "a", values);
    const done = { ...t.relay.get(kind, "a")!.state };
    t.tick();
    const plan = t.undo();
    expect(plan).toMatchObject({ type: "apply", skipped: 0 });
    expect(t.relay.get(kind, "a")!.state).toEqual(start);
    t.tick();
    t.redo();
    expect(t.relay.get(kind, "a")!.state).toEqual(done);
    t.tick();
    t.undo();
    expect(t.relay.get(kind, "a")!.state).toEqual(start);
  });

  it("group move and frame carry: one entry for the frame and its notes", () => {
    const t = setup();
    t.relay.put("frame", "f", { x: 0, y: 0, w: 640, h: 400 });
    t.relay.put("note", "a", noteState(10, 10));
    t.relay.put("note", "b", noteState(100, 10));
    t.history.recordChange(
      "Move frame",
      [
        { kind: "frame", id: "f", before: { x: 0, y: 0 }, after: { x: 50, y: 50 } },
        { kind: "note", id: "a", before: { x: 10, y: 10 }, after: { x: 60, y: 60 } },
        { kind: "note", id: "b", before: { x: 100, y: 10 }, after: { x: 150, y: 60 } },
      ],
      t.now(),
    );
    t.relay.change("frame", "f", { x: 50, y: 50 });
    t.relay.change("note", "a", { x: 60, y: 60 });
    t.relay.change("note", "b", { x: 150, y: 60 });
    t.undo();
    expect([t.relay.get("frame", "f")!.state.x, t.relay.get("note", "a")!.state.x, t.relay.get("note", "b")!.state.x]).toEqual([0, 10, 100]);
    t.redo();
    expect([t.relay.get("frame", "f")!.state.x, t.relay.get("note", "a")!.state.x, t.relay.get("note", "b")!.state.x]).toEqual([50, 60, 150]);
  });

  it("add note / add frame / duplicate / template: undo deletes what was added; redo adds it back (new ids)", () => {
    const t = setup();
    t.history.recordAdd("Duplicate", [
      { kind: "note", id: "local:1" },
      { kind: "note", id: "local:2" },
      { kind: "frame", id: "local:3" },
    ], t.now());
    expect(t.history.undoReason(t.now())).toBe(HISTORY_TEXT.unsaved);
    const n1 = t.relay.confirm("note", "local:1", noteState(1, 1, "one"));
    const n2 = t.relay.confirm("note", "local:2", { ...noteState(2, 2, "two"), z: 5 });
    const f = t.relay.confirm("frame", "local:3", { x: 0, y: 0, w: 640, h: 400, title: "F" });
    expect(t.history.undoReason(t.now())).toBeNull();
    const plan = t.undo();
    expect(plan).toMatchObject({ type: "apply", deletes: [{ kind: "note", id: n1 }, { kind: "note", id: n2 }, { kind: "frame", id: f }] });
    expect(t.relay.items.size).toBe(0);
    const again = t.redo();
    expect(again.type === "apply" && again.restores.map((r) => r.content.text ?? r.content.title)).toEqual(["one", "two", "F"]);
    expect([...t.relay.items.values()].map((i) => i.state.text ?? i.state.title).sort()).toEqual(["F", "one", "two"]);
    // And undo again removes the re-added ones (their new ids).
    t.undo();
    expect(t.relay.items.size).toBe(0);
  });

  it("an add refused by the relay is dropped from its entry", () => {
    const t = setup();
    t.history.recordAdd("Add note", [{ kind: "note", id: "local:1" }, { kind: "note", id: "local:2" }], t.now());
    t.relay.confirm("note", "local:1", noteState());
    t.history.refuse("note", "local:2");
    expect(t.history.undoReason(t.now())).toBeNull();
    const plan = t.undo();
    expect(plan.type === "apply" && plan.deletes).toHaveLength(1);
  });

  it("delete / clear: undo restores every item with its content, notes in their stacking order; redo deletes them again", () => {
    const t = setup();
    const notes = [
      { id: "a", z: 3, text: "top" },
      { id: "b", z: -1, text: "bottom" },
      { id: "c", z: 1, text: "middle" },
    ];
    for (const n of notes) t.relay.put("note", n.id, { ...noteState(0, 0, n.text), z: n.z });
    t.relay.put("frame", "f", { x: 0, y: 0, w: 640, h: 400, title: "F" });
    t.history.recordRemove(
      "Clear board",
      [
        ...notes.map((n) => ({ kind: "note" as const, id: n.id, content: { ...noteState(0, 0, n.text) }, z: n.z, rev: 1 })),
        { kind: "frame" as const, id: "f", content: { x: 0, y: 0, w: 640, h: 400, title: "F" }, z: 0, rev: 1 },
      ],
      t.now(),
    );
    expect(t.history.undoReason(t.now())).toBe(HISTORY_TEXT.unsaved);
    for (const n of notes) t.relay.remove("note", n.id);
    t.relay.remove("frame", "f");
    expect(t.history.undoReason(t.now())).toBeNull();
    const plan = t.undo();
    expect(plan.type === "apply" && plan.restores.filter((r) => r.kind === "note").map((r) => r.content.text)).toEqual(["bottom", "middle", "top"]);
    expect(t.relay.items.size).toBe(4);
    t.redo();
    expect(t.relay.items.size).toBe(0);
  });

  it("a delete refused by the relay for one item: the entry keeps only what was removed", () => {
    const t = setup();
    t.relay.put("note", "a", noteState());
    t.relay.put("note", "b", noteState());
    t.history.recordRemove("Delete", ["a", "b"].map((id) => ({ kind: "note" as const, id, content: noteState(), z: 0, rev: 1 })), t.now());
    t.relay.remove("note", "a");
    t.history.refuse("note", "b");
    const plan = t.undo();
    expect(plan.type === "apply" && plan.restores).toHaveLength(1);
  });
});

describe("other people's changes are never overwritten", () => {
  it("skips an item someone else changed since my action; the rest still apply, and it says how many", () => {
    const t = setup();
    t.relay.put("note", "a", noteState(10, 10));
    t.relay.put("note", "b", noteState(200, 10));
    t.history.recordChange(
      "Move",
      [
        { kind: "note", id: "a", before: { x: 10, y: 10 }, after: { x: 50, y: 10 } },
        { kind: "note", id: "b", before: { x: 200, y: 10 }, after: { x: 250, y: 10 } },
      ],
      t.now(),
    );
    t.relay.change("note", "a", { x: 50, y: 10 });
    t.relay.change("note", "b", { x: 250, y: 10 });
    // Someone else edits b's text: a newer rev that isn't mine.
    t.relay.change("note", "b", { text: "Theirs" });
    const plan = t.undo();
    expect(plan).toMatchObject({ type: "apply", skipped: 1 });
    expect(t.relay.get("note", "a")!.state.x).toBe(10);
    expect(t.relay.get("note", "b")!.state).toMatchObject({ x: 250, text: "Theirs" });
    expect(HISTORY_TEXT.conflicts(1)).toBe("1 item was changed by someone else and was left as it is.");
    expect(HISTORY_TEXT.conflicts(3)).toBe("3 items were changed by someone else and were left as they are.");
    // Redo only redoes what was undone.
    t.redo();
    expect(t.relay.get("note", "a")!.state.x).toBe(50);
  });

  it("an item someone else deleted is skipped", () => {
    const t = setup();
    t.relay.put("note", "a", noteState());
    t.mine("Move", "note", "a", { x: 99, y: 20 });
    t.relay.remove("note", "a");
    expect(t.undo()).toMatchObject({ type: "apply", skipped: 1, changes: [] });
  });

  it("undo of an add whose note someone else edited leaves that note", () => {
    const t = setup();
    t.history.recordAdd("Add note", [{ kind: "note", id: "local:1" }], t.now());
    const id = t.relay.confirm("note", "local:1", noteState());
    t.relay.change("note", id, { text: "Theirs" });
    expect(t.undo()).toMatchObject({ skipped: 1, deletes: [] });
    expect(t.relay.get("note", id)).toBeDefined();
  });

  it("a stacking change (z only, mine or anyone's) doesn't count as a change: the move still undoes", () => {
    const t = setup();
    t.relay.put("note", "a", noteState());
    t.mine("Move", "note", "a", { x: 99, y: 20 });
    t.relay.change("note", "a", { z: 7 });
    expect(t.undo()).toMatchObject({ skipped: 0 });
    expect(t.relay.get("note", "a")!.state).toMatchObject({ x: 10, z: 7 });
  });

  it("my own later changes don't block undoing the earlier ones (step by step)", () => {
    const t = setup();
    t.relay.put("note", "a", noteState());
    t.mine("Move", "note", "a", { x: 99, y: 20 });
    t.tick();
    t.mine("Edit text", "note", "a", { text: "Mine" });
    t.tick();
    t.mine("Style", "note", "a", { color: "blue" });
    t.undo();
    t.undo();
    expect(t.undo()).toMatchObject({ skipped: 0 });
    expect(t.relay.get("note", "a")!.state).toEqual(noteState());
    t.redo();
    t.redo();
    t.redo();
    expect(t.relay.get("note", "a")!.state).toMatchObject({ x: 99, text: "Mine", color: "blue" });
  });

  it("someone else's change between two of mine blocks the earlier one only", () => {
    const t = setup();
    t.relay.put("note", "a", noteState());
    t.mine("Move", "note", "a", { x: 99, y: 20 });
    t.relay.change("note", "a", { text: "Theirs" });
    t.tick();
    t.mine("Move", "note", "a", { x: 150, y: 20 });
    expect(t.undo()).toMatchObject({ skipped: 0 });
    expect(t.relay.get("note", "a")!.state.x).toBe(99);
    expect(t.undo()).toMatchObject({ skipped: 1 });
    expect(t.relay.get("note", "a")!.state).toMatchObject({ x: 99, text: "Theirs" });
  });

  it("an own change outside the history (a deferred edit after an add) is expected, not a conflict", () => {
    const t = setup();
    t.history.recordAdd("Add note", [{ kind: "note", id: "local:1" }], t.now());
    const id = t.relay.confirm("note", "local:1", noteState());
    t.history.expectOwn("note", id, { text: "Typed while saving" }, t.now());
    t.relay.change("note", id, { text: "Typed while saving" });
    expect(t.undo()).toMatchObject({ skipped: 0, deletes: [{ kind: "note", id }] });
  });
});

describe("id remapping", () => {
  it("delete, undo (new id), then undo an earlier move of the restored note: it applies to the new id", () => {
    const t = setup();
    t.relay.put("note", "a", noteState());
    t.mine("Move", "note", "a", { x: 300, y: 20 });
    t.tick();
    t.history.recordRemove("Delete", [{ kind: "note", id: "a", content: { ...noteState(300, 20) }, z: 0, rev: t.relay.get("note", "a")!.rev }], t.now());
    t.relay.remove("note", "a");
    t.tick();
    const restore = t.undo();
    expect(restore.type === "apply" && restore.restores).toHaveLength(1);
    const [restored] = [...t.relay.items.values()];
    expect(restored!.id).not.toBe("a");
    expect(restored!.state.x).toBe(300);
    t.tick();
    const move = t.undo();
    expect(move).toMatchObject({ type: "apply", skipped: 0, changes: [{ kind: "note", id: restored!.id, values: { x: 10, y: 20 } }] });
    expect(t.relay.get("note", restored!.id)!.state.x).toBe(10);
    // And redo both: the move, then the delete of the restored note.
    t.redo();
    expect(t.relay.get("note", restored!.id)!.state.x).toBe(300);
    t.redo();
    expect(t.relay.items.size).toBe(0);
  });

  it("the redo stack follows new ids too", () => {
    const t = setup();
    t.relay.put("note", "a", noteState());
    t.history.recordRemove("Delete", [{ kind: "note", id: "a", content: noteState(), z: 0, rev: 1 }], t.now());
    t.relay.remove("note", "a");
    t.undo();
    const restored = [...t.relay.items.values()][0]!.id;
    t.mine("Move", "note", restored, { x: 500, y: 20 });
    t.undo(); // the move
    // Redo stack now holds the move, keyed by the restored id.
    const plan = t.history.plan("redo", t.relay.lookup, t.now());
    expect(plan).toMatchObject({ type: "apply", changes: [{ id: restored }] });
  });
});

describe("order changes", () => {
  it("aren't undoable: undo skips the marker and says so; the next undo is the action before", () => {
    const t = setup();
    t.relay.put("note", "a", noteState());
    t.mine("Move", "note", "a", { x: 99, y: 20 });
    t.history.recordOrder(t.now());
    t.relay.change("note", "a", { z: 4 });
    const plan = t.history.plan("undo", t.relay.lookup, t.now());
    expect(plan).toEqual({ type: "order", message: HISTORY_TEXT.order });
    expect(HISTORY_TEXT.order).toBe("Order changes can’t be undone.");
    t.relay.run(plan, t.now());
    expect(t.history.redoReason(t.now())).toBe(HISTORY_TEXT.nothingToRedo);
    t.undo();
    expect(t.relay.get("note", "a")!.state.x).toBe(10);
  });

  it("consecutive order changes are one marker; an order change clears redo", () => {
    const t = setup();
    t.relay.put("note", "a", noteState());
    t.mine("Move", "note", "a", { x: 99, y: 20 });
    t.undo();
    t.history.recordOrder(t.now());
    t.history.recordOrder(t.now());
    expect(t.history.sizes).toEqual({ undo: 1, redo: 0 });
  });
});

describe("held items", () => {
  it("an item being moved here blocks undo with a reason", () => {
    const t = setup();
    t.relay.put("note", "a", noteState());
    t.mine("Move", "note", "a", { x: 99, y: 20 });
    const plan = t.history.plan("undo", (kind, id) => {
      const current = t.relay.lookup(kind, id);
      return current ? { ...current, held: true } : null;
    }, t.now());
    expect(plan).toEqual({ type: "none", reason: HISTORY_TEXT.held });
    expect(t.history.sizes.undo).toBe(1);
  });
});
