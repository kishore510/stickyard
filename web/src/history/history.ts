/*
 * Undo and redo for your own actions (web only; no protocol change). Pure: no socket, no board,
 * no clock (callers pass `now`). RoomSession records what it sends, tells the history what the
 * relay stored (observe, confirmAdd, deleted, refuse) and runs the plans it makes with the
 * existing messages.
 *
 * - An entry holds the items it touched, by id: for a change, the fields before and after; for
 *   items added or removed, their whole content (and stacking z). A "presence" item is either on
 *   the board (`present`: undo deletes it) or not (undo adds it back as a new item).
 * - Revs: each change record knows the item's rev with its `before` state (`beforeRev`) and with
 *   its `after` state (`afterRev`), as the relay stored them. Undo applies to an item only if its
 *   current rev is still `afterRev` (redo: `beforeRev`); otherwise someone else changed it since
 *   and it's skipped. Applying a state again (an undo, a redo) is stored at a new rev, so every
 *   reference to the rev it stands for is moved to the new one (`remap`). A change of z alone
 *   (bring to front, a renumbering) remaps too: it never conflicts.
 * - What's sent but not heard back yet is an expectation (the values the relay should store). An
 *   entry with expectations isn't undoable yet ("wait until saved"). Matching is by value, in
 *   order; an expectation unheard after EXPECT_TIMEOUT_MS is dropped with its record.
 * - Items added back get new ids from the relay: every entry in both stacks follows them
 *   (renameId), so earlier steps still work on the restored items.
 */

export type ItemKind = "note" | "frame";
export type Value = string | number | boolean;
/** Some of an item's fields (a change's before or after, or everything the relay stored). */
export type Fields = Readonly<Record<string, Value>>;

/** The most entries kept; older ones are dropped. */
export const HISTORY_DEPTH = 50;
/** The most content kept (estimated: 2 bytes per character of the entries as JSON); oldest dropped first. */
export const HISTORY_MAX_BYTES = 2_000_000;
/** Moves of the same items this close together are one step (arrow-key repeats). */
export const COALESCE_MS = 500;
/** A change the relay hasn't confirmed this long after it was sent is given up on. */
export const EXPECT_TIMEOUT_MS = 10_000;

export const HISTORY_TEXT = {
  nothingToUndo: "Nothing to undo.",
  nothingToRedo: "Nothing to redo.",
  unsaved: "Wait until your last change is saved.",
  held: "Finish moving or resizing first.",
  order: "Order changes can’t be undone.",
  conflicts: (n: number) =>
    n === 1 ? "1 item was changed by someone else and was left as it is." : `${n} items were changed by someone else and were left as they are.`,
} as const;

interface ChangeRecord {
  kind: ItemKind;
  id: string;
  before: Fields;
  after: Fields;
  beforeRev: number | null;
  afterRev: number | null;
}

interface PresenceRecord {
  kind: ItemKind;
  id: string;
  /** Everything but id, rev, author and z (null while an add hasn't been confirmed and nothing was captured yet). */
  content: Fields | null;
  z: number;
  /** The rev while it's on the board; for an item not on the board, the rev it had when it went. */
  rev: number | null;
  present: boolean;
  /** Sent and waiting: an add (its server id) or a delete. */
  pending: "add" | "delete" | null;
}

interface Entry {
  seq: number;
  label: string;
  at: number;
  coalesce: string | null;
  order: boolean;
  changes: ChangeRecord[];
  items: PresenceRecord[];
}

type Mode = "do" | "undo" | "redo" | "own";

interface Expect {
  kind: ItemKind;
  id: string;
  /** The entry it belongs to (null: an own change outside the history). */
  seq: number | null;
  mode: Mode;
  values: Fields;
  at: number;
}

/** What the item is now, as the relay last stored it; null if it isn't on the board (or not confirmed). */
export interface Current {
  rev: number;
  held: boolean;
  state: Fields;
}
export type Lookup = (kind: ItemKind, id: string) => Current | null;

export interface ChangeStep {
  kind: ItemKind;
  id: string;
  values: Fields;
}
export interface DeleteStep {
  kind: ItemKind;
  id: string;
  /** What it is now (kept, to add it back on the next step). */
  content: Fields;
  z: number;
}
export interface RestoreStep {
  kind: ItemKind;
  /** The id it had (entries are rewritten to the new one). */
  id: string;
  content: Fields;
  z: number;
}

export type Plan =
  | { type: "none"; reason: string }
  | { type: "order"; message: string }
  | {
      type: "apply";
      direction: "undo" | "redo";
      seq: number;
      label: string;
      changes: ChangeStep[];
      deletes: DeleteStep[];
      /** Notes in stacking order (bottom first), then frames. */
      restores: RestoreStep[];
      /** Items left as they are because someone else changed (or deleted) them. */
      skipped: number;
    };

const sameValues = (state: Fields, values: Fields) => Object.entries(values).every(([k, v]) => state[k] === v);
const without = (state: Fields, keys: readonly string[]): Fields => Object.fromEntries(Object.entries(state).filter(([k]) => !keys.includes(k)));
/** Fields an item's content never carries: the server assigns them, and z travels apart. */
const SERVER_FIELDS = ["id", "rev", "authorId", "z"] as const;

export class History {
  private undo: Entry[] = [];
  private redo: Entry[] = [];
  private expects: Expect[] = [];
  private seq = 0;
  private readonly depth: number;
  private readonly maxBytes: number;

  constructor({ depth = HISTORY_DEPTH, maxBytes = HISTORY_MAX_BYTES }: { depth?: number; maxBytes?: number } = {}) {
    this.depth = depth;
    this.maxBytes = maxBytes;
  }

  get sizes(): { undo: number; redo: number } {
    return { undo: this.undo.length, redo: this.redo.length };
  }

  /** The estimated size of everything kept. */
  get bytes(): number {
    return [...this.undo, ...this.redo].reduce((n, e) => n + entryBytes(e), 0);
  }

  /** Forgets everything (a resync, a reconnect, leaving: ids and revs can't be trusted any more). */
  clear(): void {
    this.undo = [];
    this.redo = [];
    this.expects = [];
  }

  /* ── Recording ───────────────────────────────────────────────────── */

  /**
   * My change to some items (moves, resizes, text, style, frame edits), sent and waiting for the
   * relay. Records with nothing changed are left out. With `coalesce`, a change to the same items
   * within COALESCE_MS of the last one (same key) extends it instead of adding a step.
   */
  recordChange(label: string, changes: readonly { kind: ItemKind; id: string; before: Fields; after: Fields }[], now: number, coalesce?: string): void {
    const real = changes.filter((c) => !sameValues(c.before, c.after));
    if (real.length === 0) return;
    const top = this.undo.at(-1);
    const keys = (rs: readonly { kind: ItemKind; id: string }[]) => rs.map((r) => `${r.kind}:${r.id}`).sort().join(" ");
    if (coalesce && top && top.coalesce === coalesce && !top.order && now - top.at <= COALESCE_MS && top.items.length === 0 && keys(top.changes) === keys(real)) {
      for (const c of real) {
        const record = top.changes.find((r) => r.kind === c.kind && r.id === c.id);
        if (!record) continue;
        record.after = { ...record.after, ...c.after };
        record.before = { ...c.before, ...record.before };
        this.expect(c.kind, c.id, top.seq, "do", c.after, now);
      }
      top.at = now;
      this.redo = [];
      return;
    }
    const entry = this.newEntry(label, now, coalesce ?? null);
    entry.changes = real.map((c) => ({ kind: c.kind, id: c.id, before: { ...c.before }, after: { ...c.after }, beforeRev: null, afterRev: null }));
    for (const c of real) this.expect(c.kind, c.id, entry.seq, "do", c.after, now);
    this.push(entry);
  }

  /** Items I added (local ids until confirmed): undo deletes them. */
  recordAdd(label: string, items: readonly { kind: ItemKind; id: string }[], now: number): void {
    if (items.length === 0) return;
    const entry = this.newEntry(label, now, null);
    entry.items = items.map((i) => ({ kind: i.kind, id: i.id, content: null, z: 0, rev: null, present: true, pending: "add" }));
    this.push(entry);
  }

  /** Items I deleted (sent, waiting for the relay), with their content and z: undo adds them back. */
  recordRemove(label: string, items: readonly { kind: ItemKind; id: string; content: Fields; z: number; rev: number }[], now: number): void {
    if (items.length === 0) return;
    const entry = this.newEntry(label, now, null);
    entry.items = items.map((i) => ({ kind: i.kind, id: i.id, content: without(i.content, SERVER_FIELDS), z: i.z, rev: i.rev, present: false, pending: "delete" }));
    this.push(entry);
  }

  /** A stacking change of mine: not undoable, but undo says so when it reaches it. */
  recordOrder(now: number): void {
    const top = this.undo.at(-1);
    this.redo = [];
    if (top?.order) {
      top.at = now;
      return;
    }
    const entry = this.newEntry("Order", now, null);
    entry.order = true;
    this.push(entry);
  }

  /** An own change that isn't a step of its own (an edit made while an add was in flight): when stored, it isn't someone else's. */
  expectOwn(kind: ItemKind, id: string, values: Fields, now: number): void {
    this.expect(kind, id, null, "own", values, now);
  }

  /** What my changes still in flight will make these fields (so a new change starts from there). */
  pendingValues(kind: ItemKind, id: string): Fields {
    let out: Record<string, Value> = {};
    for (const e of this.expects) if (e.kind === kind && e.id === id) out = { ...out, ...e.values };
    return out;
  }

  /** Items with changes of mine sent and not heard back yet, as "kind:id" (a dropped connection counts them). */
  pendingKeys(): string[] {
    return [...new Set(this.expects.map((e) => `${e.kind}:${e.id}`))];
  }

  /** When the oldest change still waiting will be given up on (so undo and redo can say so then), or null. */
  nextExpiry(): number | null {
    if (this.expects.length === 0) return null;
    return Math.min(...this.expects.map((e) => e.at)) + EXPECT_TIMEOUT_MS + 1;
  }

  /* ── What the relay stored ───────────────────────────────────────── */

  /**
   * The relay stored a change to an item (anyone's): `prevRev` is what it had, `state` everything
   * it is now. Mine (an expectation matches): its revs are noted. A change of z alone: remapped.
   * Anything else is someone else's, and makes my records for that item stale.
   */
  observe(kind: ItemKind, id: string, prevRev: number, rev: number, state: Fields, zOnly: boolean): void {
    const index = this.expects.findIndex((e) => e.kind === kind && e.id === id && sameValues(state, e.values));
    const expect = this.expects[index];
    if (!expect) {
      if (zOnly && prevRev !== rev) this.remap(kind, id, prevRev, rev);
      return;
    }
    this.expects.splice(index, 1);
    const record = expect.seq === null ? undefined : this.entry(expect.seq)?.changes.find((r) => r.kind === kind && r.id === id);
    if (expect.mode === "own" || !record) {
      if (prevRev !== rev) this.remap(kind, id, prevRev, rev);
      return;
    }
    if (expect.mode === "do") {
      if (prevRev === rev && record.afterRev === null) return this.dropRecord(expect.seq, kind, id);
      record.beforeRev ??= prevRev;
      record.afterRev = rev;
      return;
    }
    const old = expect.mode === "undo" ? record.beforeRev : record.afterRev;
    if (old !== null && old !== rev) this.remap(kind, id, old, rev);
    if (expect.mode === "undo") record.beforeRev = rev;
    else record.afterRev = rev;
  }

  /** An add of mine got its server id and rev: every entry follows the new id. */
  confirmAdd(kind: ItemKind, localId: string, id: string, rev: number): void {
    const records = this.presence(kind, localId).filter((r) => r.pending === "add");
    this.renameId(kind, localId, id);
    for (const r of records) {
      if (r.rev !== null && r.rev !== rev) this.remap(kind, id, r.rev, rev);
      r.rev = rev;
      r.pending = null;
    }
  }

  /** An item left the board (anyone deleted it): my deletes waiting for it are done. */
  deleted(kind: ItemKind, id: string): void {
    for (const r of this.presence(kind, id)) if (r.pending === "delete") r.pending = null;
    this.expects = this.expects.filter((e) => !(e.kind === kind && e.id === id));
  }

  /** The relay refused something of mine for this item (or it never got there): its waiting records go. */
  refuse(kind: ItemKind, id: string): void {
    const seqs = new Set(this.expects.filter((e) => e.kind === kind && e.id === id && e.seq !== null).map((e) => e.seq as number));
    this.expects = this.expects.filter((e) => !(e.kind === kind && e.id === id));
    for (const seq of seqs) this.dropRecord(seq, kind, id);
    for (const stack of [this.undo, this.redo]) {
      for (const entry of stack) entry.items = entry.items.filter((r) => !(r.kind === kind && r.id === id && r.pending !== null));
    }
    this.dropEmpty();
  }

  /** Every reference to an item follows its new id. */
  renameId(kind: ItemKind, from: string, to: string): void {
    for (const entry of [...this.undo, ...this.redo]) {
      for (const r of entry.changes) if (r.kind === kind && r.id === from) r.id = to;
      for (const r of entry.items) if (r.kind === kind && r.id === from) r.id = to;
    }
    for (const e of this.expects) if (e.kind === kind && e.id === from) e.id = to;
  }

  /* ── Undo and redo ───────────────────────────────────────────────── */

  undoReason(now: number): string | null {
    return this.reason("undo", now);
  }

  redoReason(now: number): string | null {
    return this.reason("redo", now);
  }

  /**
   * What undo (or redo) would do now: the top entry's records whose item is as my action left it
   * (current rev), the rest skipped. Doesn't change anything; `applied` does once it's sent.
   */
  plan(direction: "undo" | "redo", lookup: Lookup, now: number): Plan {
    const reason = this.reason(direction, now);
    if (reason !== null) return { type: "none", reason };
    const stack = direction === "undo" ? this.undo : this.redo;
    const entry = stack.at(-1);
    if (!entry) return { type: "none", reason: direction === "undo" ? HISTORY_TEXT.nothingToUndo : HISTORY_TEXT.nothingToRedo };
    if (entry.order) return { type: "order", message: HISTORY_TEXT.order };
    let skipped = 0;
    const changes: ChangeStep[] = [];
    for (const r of entry.changes) {
      const current = lookup(r.kind, r.id);
      if (current?.held) return { type: "none", reason: HISTORY_TEXT.held };
      const want = direction === "undo" ? r.afterRev : r.beforeRev;
      if (!current || want === null || current.rev !== want) skipped++;
      else changes.push({ kind: r.kind, id: r.id, values: direction === "undo" ? r.before : r.after });
    }
    const deletes: DeleteStep[] = [];
    const restores: RestoreStep[] = [];
    for (const r of entry.items) {
      if (!r.present) {
        if (r.content) restores.push({ kind: r.kind, id: r.id, content: r.content, z: r.z });
        continue;
      }
      const current = lookup(r.kind, r.id);
      if (current?.held) return { type: "none", reason: HISTORY_TEXT.held };
      if (!current || current.rev !== r.rev) skipped++;
      else deletes.push({ kind: r.kind, id: r.id, content: without(current.state, SERVER_FIELDS), z: typeof current.state.z === "number" ? current.state.z : r.z });
    }
    restores.sort((a, b) => (a.kind === b.kind ? (a.kind === "note" ? a.z - b.z : 0) : a.kind === "note" ? -1 : 1));
    return { type: "apply", direction, seq: entry.seq, label: entry.label, changes, deletes, restores, skipped };
  }

  /**
   * A plan was sent: its entry moves to the other stack with only what was applied, waiting for
   * the relay. `newIds` maps each restored item ("kind:oldId") to the local id it was added under.
   */
  applied(plan: Plan, newIds: ReadonlyMap<string, string>, now: number): void {
    if (plan.type === "none") return;
    if (plan.type === "order") {
      if (this.undo.at(-1)?.order) this.undo.pop();
      return;
    }
    const from = plan.direction === "undo" ? this.undo : this.redo;
    const index = from.findIndex((e) => e.seq === plan.seq);
    const entry = from[index];
    if (!entry) return;
    from.splice(index, 1);
    // On the other stack first, so renaming below reaches this entry too.
    const to = plan.direction === "undo" ? this.redo : this.undo;
    to.push(entry);
    const changed = new Set(plan.changes.map((c) => `${c.kind}:${c.id}`));
    const deleted = new Map(plan.deletes.map((d) => [`${d.kind}:${d.id}`, d]));
    entry.changes = entry.changes.filter((r) => changed.has(`${r.kind}:${r.id}`));
    for (const c of plan.changes) this.expect(c.kind, c.id, entry.seq, plan.direction, c.values, now);
    entry.items = entry.items.filter((r) => !r.present || deleted.has(`${r.kind}:${r.id}`));
    for (const r of entry.items) {
      if (r.present) {
        const step = deleted.get(`${r.kind}:${r.id}`);
        if (step) {
          r.content = step.content;
          r.z = step.z;
        }
        r.present = false;
        r.pending = "delete";
        continue;
      }
      const local = newIds.get(`${r.kind}:${r.id}`);
      if (!local) {
        r.pending = null;
        r.content = null;
        continue;
      }
      // A new item: references to older states of the old one can't be checked any more.
      this.forgetRevs(r.kind, r.id, r.rev);
      this.renameId(r.kind, r.id, local);
      r.present = true;
      r.pending = "add";
    }
    entry.items = entry.items.filter((r) => r.content !== null || r.present);
    entry.at = now;
    this.dropEmpty();
    this.trim();
  }

  /* ── Internals ───────────────────────────────────────────────────── */

  private reason(direction: "undo" | "redo", now: number): string | null {
    this.expire(now);
    const entry = (direction === "undo" ? this.undo : this.redo).at(-1);
    if (!entry) return direction === "undo" ? HISTORY_TEXT.nothingToUndo : HISTORY_TEXT.nothingToRedo;
    if (this.expects.some((e) => e.seq === entry.seq) || entry.items.some((r) => r.pending !== null)) return HISTORY_TEXT.unsaved;
    return null;
  }

  private newEntry(label: string, at: number, coalesce: string | null): Entry {
    return { seq: ++this.seq, label, at, coalesce, order: false, changes: [], items: [] };
  }

  private push(entry: Entry): void {
    this.undo.push(entry);
    this.redo = [];
    this.trim();
  }

  /** Oldest first, past the depth or the size cap (the newest entry always stays). */
  private trim(): void {
    while (this.undo.length > this.depth) this.dropOldest();
    while (this.undo.length + this.redo.length > 1 && this.bytes > this.maxBytes) this.dropOldest();
  }

  private dropOldest(): void {
    const entry = this.undo.length > 0 ? this.undo.shift() : this.redo.shift();
    if (entry) this.expects = this.expects.filter((e) => e.seq !== entry.seq);
  }

  private entry(seq: number): Entry | undefined {
    return this.undo.find((e) => e.seq === seq) ?? this.redo.find((e) => e.seq === seq);
  }

  private presence(kind: ItemKind, id: string): PresenceRecord[] {
    return [...this.undo, ...this.redo].flatMap((e) => e.items.filter((r) => r.kind === kind && r.id === id));
  }

  private expect(kind: ItemKind, id: string, seq: number | null, mode: Mode, values: Fields, at: number): void {
    this.expects.push({ kind, id, seq, mode, values: { ...values }, at });
  }

  private dropRecord(seq: number | null, kind: ItemKind, id: string): void {
    if (seq === null) return;
    const entry = this.entry(seq);
    if (!entry) return;
    entry.changes = entry.changes.filter((r) => !(r.kind === kind && r.id === id));
    this.expects = this.expects.filter((e) => !(e.seq === seq && e.kind === kind && e.id === id));
    this.dropEmpty();
  }

  private dropEmpty(): void {
    const empty = (e: Entry) => !e.order && e.changes.length === 0 && e.items.length === 0;
    this.undo = this.undo.filter((e) => !empty(e));
    this.redo = this.redo.filter((e) => !empty(e));
  }

  /** Expectations unheard for too long: their records go (the relay never stored them, or we missed it). */
  private expire(now: number): void {
    const old = this.expects.filter((e) => now - e.at > EXPECT_TIMEOUT_MS);
    if (old.length === 0) return;
    this.expects = this.expects.filter((e) => now - e.at <= EXPECT_TIMEOUT_MS);
    for (const e of old) this.dropRecord(e.seq, e.kind, e.id);
  }

  /** Every reference to the item's rev `from` now means `to` (the same state, stored again). */
  private remap(kind: ItemKind, id: string, from: number, to: number): void {
    for (const entry of [...this.undo, ...this.redo]) {
      for (const r of entry.changes) {
        if (r.kind !== kind || r.id !== id) continue;
        if (r.beforeRev === from) r.beforeRev = to;
        if (r.afterRev === from) r.afterRev = to;
      }
      for (const r of entry.items) if (r.kind === kind && r.id === id && r.rev === from) r.rev = to;
    }
  }

  /** Keeps only references to rev `keep` of this item (it's coming back as a new item at that state). */
  private forgetRevs(kind: ItemKind, id: string, keep: number | null): void {
    for (const entry of [...this.undo, ...this.redo]) {
      for (const r of entry.changes) {
        if (r.kind !== kind || r.id !== id) continue;
        if (r.beforeRev !== keep) r.beforeRev = null;
        if (r.afterRev !== keep) r.afterRev = null;
      }
    }
  }
}

function entryBytes(entry: Entry): number {
  return JSON.stringify(entry).length * 2;
}
