import {
  CONNECTOR_DEFAULTS,
  FRAME_DEFAULTS,
  FRAME_DEFAULT_H,
  FRAME_DEFAULT_W,
  NOTE_DEFAULTS,
  REACTION_KEYS,
  VOTE_BUDGET_MAX,
  anchorPoint,
  clampConnectorPoint,
  clampFrameRect,
  clampNoteRect,
  clampShapeRect,
  clampZ,
  connectorSchema,
  endReference,
  frameSchema,
  isBound,
  noteSchema,
  shapeDefaults,
  shapeSchema,
  type Box,
  type Connector,
  type ConnectorEnd,
  type Frame,
  type Note,
  type ReactionKey,
  type Shape,
} from "@stickyard/shared";

/**
 * A room's notes, in its Durable Object's SQLite. Written only on commits (add, edit, final
 * move or resize, delete), never per drag or resize message. Held in memory once loaded, so
 * reads after the first are free; loaded again when the object wakes from hibernation.
 *
 * Schema versions (bump SCHEMA_VERSION and add a step to `migrate` for any change):
 *   1 (slice 2): meta(key, value) and notes(id, x, y, text, color, rev, author_id).
 *   2 (slice 2.7): notes gains w, h, font_size, bold, italic, text_color, align. Every new
 *     column is NOT NULL with the default as its DEFAULT, so existing rows get the default size
 *     and style, and older code that inserts or updates without them still works (rollback).
 *   3 (slice 2.7.1): notes gains title_align (NOT NULL DEFAULT 'left'), set to each note's
 *     existing align so titles look the same as before.
 *   4 (slice 2.7.2): notes gains title_font_size, title_bold, title_italic, title_text_color
 *     (NOT NULL, defaults from NOTE_DEFAULTS), set once to each note's body values so titles
 *     look the same as before. Version 3 code still inserts and updates without them.
 *   5 (slice z-order): notes gains z (stacking order, NOT NULL DEFAULT 0), set once to each
 *     note's place in creation (rowid) order, 0..n-1, which is how notes were stacked before.
 *     Version 4 code still inserts (z 0) and updates (z kept) without it.
 *   6 (slice frames): a new frames table (id, x, y, w, h, title, color, rev, author_id), every
 *     column but the key with a DEFAULT. Additive: notes are untouched, and version 5 code (which
 *     never reads frames) keeps working on it.
 *   7 (slice frame title styling): frames gains title_font_size, title_bold, title_italic,
 *     title_text_color, title_align (NOT NULL, defaults from FRAME_DEFAULTS, which look like the
 *     v9 header). Nothing to copy, so existing frames look unchanged; version 6 code still inserts
 *     and updates frames without them.
 *   8 (dot voting): a new votes table (voter_id, note_id, count; key voter_id + note_id), every
 *     column with a DEFAULT. Additive: version 7 code never reads it. Rows are only ever written
 *     with a count of 1 to VOTE_BUDGET_MAX; a note's rows go with it (same transaction). Votes
 *     that version 7 code leaves behind on a note it deletes are ignored on load (note ids are
 *     random, so the note never comes back). The voting state lives in meta (no version needed).
 *   9 (text and shapes): a new shapes table (id, kind, x, y, w, h, text, fill, stroke,
 *     stroke_width, stroke_style, font_size, bold, italic, underline, text_color, align, valign, z,
 *     rev, author_id), every column but the key with a DEFAULT (the rectangle's defaults: SQL
 *     can't give per-kind ones, and every row we write names every column). Additive: notes,
 *     frames and votes are untouched, and version 8 code never reads it. Shapes share the notes'
 *     z space; a version 8 Worker after a rollback would stack its new notes above them anyway.
 *  10 (silent brainstorm): notes gains sealed (INTEGER NOT NULL DEFAULT 0) and writer (TEXT,
 *     DEFAULT NULL). A note added while a silent round runs is stored with sealed = 1 and its
 *     writer (an HMAC of the page's client key, see writerId.ts); a reveal sets sealed = 0 and
 *     writer = NULL on every one in one transaction. Existing rows become sealed 0, writer NULL.
 *     Version 9 code still inserts (sealed 0) and updates (seal kept) without them; after a
 *     rollback it would show sealed notes to everyone, since it doesn't know the column. The
 *     round itself lives in meta (silent_active, silent_round; no version needed).
 *  11 (reactions): a new reactions table (reactor_id, note_id, reaction_key; all three are the
 *     primary key), every column with a DEFAULT. One row per reaction that is on; turning it off
 *     deletes the row. Additive: every other table is untouched, and version 10 code never reads
 *     it. A note's rows go with it (same transaction). Rows that version 10 code leaves behind on
 *     a note it deletes, and rows with a key outside REACTION_KEYS, are ignored on load.
 *  12 (connectors): a new connectors table (id; start_item, start_anchor, start_x, start_y and the
 *     same four for the end; route, dash, width, ink, start_head, end_head, rev, author_id), every
 *     column but the key with a DEFAULT. A bound end stores its item and anchor and NULL
 *     coordinates; a free end NULL item and anchor and whole-unit coordinates. Additive: every other
 *     table is untouched, and version 11 code never reads it. Deleting a note or shape turns the
 *     ends bound to it free, in the same transaction. A connector that version 11 code leaves bound
 *     to an item it deleted (after a rollback) is skipped on load (ids are random: it never
 *     comes back), as are rows that don't validate.
 */
export const SCHEMA_VERSION = 12;

/** The connectors table (schema 12). */
const CONNECTORS_TABLE = `CREATE TABLE IF NOT EXISTS connectors (
          id TEXT PRIMARY KEY,
          start_item TEXT DEFAULT NULL,
          start_anchor TEXT DEFAULT NULL,
          start_x INTEGER DEFAULT NULL,
          start_y INTEGER DEFAULT NULL,
          end_item TEXT DEFAULT NULL,
          end_anchor TEXT DEFAULT NULL,
          end_x INTEGER DEFAULT NULL,
          end_y INTEGER DEFAULT NULL,
          route TEXT NOT NULL DEFAULT '${CONNECTOR_DEFAULTS.route}',
          dash TEXT NOT NULL DEFAULT '${CONNECTOR_DEFAULTS.dash}',
          width TEXT NOT NULL DEFAULT '${CONNECTOR_DEFAULTS.width}',
          ink TEXT NOT NULL DEFAULT '${CONNECTOR_DEFAULTS.ink}',
          start_head TEXT NOT NULL DEFAULT '${CONNECTOR_DEFAULTS.startHead}',
          end_head TEXT NOT NULL DEFAULT '${CONNECTOR_DEFAULTS.endHead}',
          rev INTEGER NOT NULL DEFAULT 1,
          author_id TEXT NOT NULL DEFAULT ''
        )`;
const CONNECTOR_COLUMNS =
  "id, start_item, start_anchor, start_x, start_y, end_item, end_anchor, end_x, end_y, route, dash, width, ink, start_head, end_head, rev, author_id";

interface ConnectorRow extends Record<string, SqlStorageValue> {
  id: string;
  start_item: string | null;
  start_anchor: string | null;
  start_x: number | null;
  start_y: number | null;
  end_item: string | null;
  end_anchor: string | null;
  end_x: number | null;
  end_y: number | null;
  route: string;
  dash: string;
  width: string;
  ink: string;
  start_head: string;
  end_head: string;
  rev: number;
  author_id: string;
}

/** The reactions table (schema 11). */
const REACTIONS_TABLE = `CREATE TABLE IF NOT EXISTS reactions (
          reactor_id TEXT NOT NULL DEFAULT '',
          note_id TEXT NOT NULL DEFAULT '',
          reaction_key TEXT NOT NULL DEFAULT '',
          PRIMARY KEY (reactor_id, note_id, reaction_key)
        )`;
const isReactionKey = (key: string): key is ReactionKey => (REACTION_KEYS as readonly string[]).includes(key);

const RECT = shapeDefaults("rect");
/** The shapes table (schema 9). */
const SHAPES_TABLE = `CREATE TABLE IF NOT EXISTS shapes (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL DEFAULT 'rect',
          x INTEGER NOT NULL DEFAULT 0,
          y INTEGER NOT NULL DEFAULT 0,
          w INTEGER NOT NULL DEFAULT ${RECT.w},
          h INTEGER NOT NULL DEFAULT ${RECT.h},
          text TEXT NOT NULL DEFAULT '',
          fill TEXT NOT NULL DEFAULT '${RECT.fill}',
          stroke TEXT NOT NULL DEFAULT '${RECT.stroke}',
          stroke_width TEXT NOT NULL DEFAULT '${RECT.strokeWidth}',
          stroke_style TEXT NOT NULL DEFAULT '${RECT.strokeStyle}',
          font_size TEXT NOT NULL DEFAULT '${RECT.fontSize}',
          bold INTEGER NOT NULL DEFAULT ${Number(RECT.bold)},
          italic INTEGER NOT NULL DEFAULT ${Number(RECT.italic)},
          underline INTEGER NOT NULL DEFAULT ${Number(RECT.underline)},
          text_color TEXT NOT NULL DEFAULT '${RECT.textColor}',
          align TEXT NOT NULL DEFAULT '${RECT.align}',
          valign TEXT NOT NULL DEFAULT '${RECT.valign}',
          z INTEGER NOT NULL DEFAULT 0,
          rev INTEGER NOT NULL DEFAULT 1,
          author_id TEXT NOT NULL DEFAULT ''
        )`;

/** Columns added by version 2, with their SQL definitions. Defaults come from NOTE_DEFAULTS. */
const V2_COLUMNS: [name: string, definition: string][] = [
  ["w", `INTEGER NOT NULL DEFAULT ${NOTE_DEFAULTS.w}`],
  ["h", `INTEGER NOT NULL DEFAULT ${NOTE_DEFAULTS.h}`],
  ["font_size", `TEXT NOT NULL DEFAULT '${NOTE_DEFAULTS.fontSize}'`],
  ["bold", `INTEGER NOT NULL DEFAULT ${Number(NOTE_DEFAULTS.bold)}`],
  ["italic", `INTEGER NOT NULL DEFAULT ${Number(NOTE_DEFAULTS.italic)}`],
  ["text_color", `TEXT NOT NULL DEFAULT '${NOTE_DEFAULTS.textColor}'`],
  ["align", `TEXT NOT NULL DEFAULT '${NOTE_DEFAULTS.align}'`],
];

/** Columns added by version 4, each copied once from the body column named last. */
const V4_COLUMNS: [name: string, definition: string, from: string][] = [
  ["title_font_size", `TEXT NOT NULL DEFAULT '${NOTE_DEFAULTS.titleFontSize}'`, "font_size"],
  ["title_bold", `INTEGER NOT NULL DEFAULT ${Number(NOTE_DEFAULTS.titleBold)}`, "bold"],
  ["title_italic", `INTEGER NOT NULL DEFAULT ${Number(NOTE_DEFAULTS.titleItalic)}`, "italic"],
  ["title_text_color", `TEXT NOT NULL DEFAULT '${NOTE_DEFAULTS.titleTextColor}'`, "text_color"],
];

/** Frame columns added by version 7. Defaults come from FRAME_DEFAULTS. */
const V7_FRAME_COLUMNS: [name: string, definition: string][] = [
  ["title_font_size", `TEXT NOT NULL DEFAULT '${FRAME_DEFAULTS.titleFontSize}'`],
  ["title_bold", `INTEGER NOT NULL DEFAULT ${Number(FRAME_DEFAULTS.titleBold)}`],
  ["title_italic", `INTEGER NOT NULL DEFAULT ${Number(FRAME_DEFAULTS.titleItalic)}`],
  ["title_text_color", `TEXT NOT NULL DEFAULT '${FRAME_DEFAULTS.titleTextColor}'`],
  ["title_align", `TEXT NOT NULL DEFAULT '${FRAME_DEFAULTS.titleAlign}'`],
];

interface NoteRow extends Record<string, SqlStorageValue> {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  color: string;
  font_size: string;
  bold: number;
  italic: number;
  text_color: string;
  align: string;
  title_align: string;
  title_font_size: string;
  title_bold: number;
  title_italic: number;
  title_text_color: string;
  z: number;
  rev: number;
  author_id: string;
  sealed: number;
  writer: string | null;
}

interface FrameRow extends Record<string, SqlStorageValue> {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  color: string;
  rev: number;
  author_id: string;
  title_font_size: string;
  title_bold: number;
  title_italic: number;
  title_text_color: string;
  title_align: string;
}

interface ShapeRow extends Record<string, SqlStorageValue> {
  id: string;
  kind: string;
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  fill: string;
  stroke: string;
  stroke_width: string;
  stroke_style: string;
  font_size: string;
  bold: number;
  italic: number;
  underline: number;
  text_color: string;
  align: string;
  valign: string;
  z: number;
  rev: number;
  author_id: string;
}

const SHAPE_COLUMNS = "id, kind, x, y, w, h, text, fill, stroke, stroke_width, stroke_style, font_size, bold, italic, underline, text_color, align, valign, z, rev, author_id";

const FRAME_COLUMNS = "id, x, y, w, h, title, color, rev, author_id, title_font_size, title_bold, title_italic, title_text_color, title_align";

const COLUMNS =
  "id, x, y, w, h, text, color, font_size, bold, italic, text_color, align, title_align, title_font_size, title_bold, title_italic, title_text_color, z, rev, author_id";

/** Runs `fn` as one SQLite transaction (the Durable Object's transactionSync). */
export type Transact = (fn: () => void) => void;

export class NoteStore {
  /** Rows written by this instance. Tests use it to prove drags and resizes don't write. */
  rowsWritten = 0;
  /** Batch transactions committed by this instance (tests check a final batch is one). */
  transactions = 0;
  private cache: Map<string, Note> | null = null;
  private frameCache: Map<string, Frame> | null = null;
  private shapeCache: Map<string, Shape> | null = null;
  /** Votes by voter id, then note id (counts 1 to VOTE_BUDGET_MAX). */
  private voteCache: Map<string, Map<string, number>> | null = null;
  /** Reactions (schema 11) by note id, then key: the reactors (voter ids) who have it on. */
  private reactionCache: Map<string, Map<ReactionKey, Set<string>>> | null = null;
  /** Reactions each reactor has on, and the room's total rows (both from reactionCache). */
  private reactorTotals = new Map<string, number>();
  private reactionTotal = 0;
  /** Connectors (schema 12) by id, in creation order. */
  private connectorCache: Map<string, Connector> | null = null;
  /**
   * Sealed notes (schema 10) and their writer ids, filled with the notes. Never on a Note: a note
   * on the wire has no seal or writer. A sealed row without a writer (never written by us) gets
   * "" so nobody's view matches it until a reveal.
   */
  private writers = new Map<string, string>();
  /**
   * Sealed notes deleted during the current message, so the room's outbound filter still knows
   * their noteDeleted is the writer's alone. Cleared by forgetGone before each message.
   */
  private goneWriters = new Map<string, string>();

  constructor(
    private readonly sql: SqlStorage,
    private readonly transact: Transact = (fn) => fn(),
  ) {
    this.migrate();
  }

  /**
   * Brings the database up to SCHEMA_VERSION, one step at a time. Each step runs only when the
   * stored version is below it (so never twice), and is safe to repeat if it was interrupted.
   */
  private migrate(): void {
    this.sql.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL)");
    const row = this.sql.exec<{ value: number }>("SELECT value FROM meta WHERE key = 'schema_version'").toArray()[0];
    const version = row?.value ?? 0;
    if (version >= SCHEMA_VERSION) return;
    if (version < 1) {
      this.sql.exec(
        `CREATE TABLE IF NOT EXISTS notes (
          id TEXT PRIMARY KEY,
          x INTEGER NOT NULL,
          y INTEGER NOT NULL,
          text TEXT NOT NULL,
          color TEXT NOT NULL,
          rev INTEGER NOT NULL,
          author_id TEXT NOT NULL
        )`,
      );
    }
    if (version < 2) {
      const existing = new Set(this.sql.exec<{ name: string }>("SELECT name FROM pragma_table_info('notes')").toArray().map((c) => c.name));
      for (const [name, definition] of V2_COLUMNS) {
        if (!existing.has(name)) this.sql.exec(`ALTER TABLE notes ADD COLUMN ${name} ${definition}`);
      }
    }
    if (version < 3) {
      const existing = new Set(this.sql.exec<{ name: string }>("SELECT name FROM pragma_table_info('notes')").toArray().map((c) => c.name));
      if (!existing.has("title_align")) {
        this.sql.exec(`ALTER TABLE notes ADD COLUMN title_align TEXT NOT NULL DEFAULT '${NOTE_DEFAULTS.titleAlign}'`);
      }
      // Titles keep the alignment the whole note had. Safe to repeat: it only runs below version 3.
      this.write("UPDATE notes SET title_align = align");
    }
    if (version < 4) {
      const existing = new Set(this.sql.exec<{ name: string }>("SELECT name FROM pragma_table_info('notes')").toArray().map((c) => c.name));
      for (const [name, definition] of V4_COLUMNS) {
        if (!existing.has(name)) this.sql.exec(`ALTER TABLE notes ADD COLUMN ${name} ${definition}`);
      }
      // Titles keep the style the whole note had. Safe to repeat: it only runs below version 4.
      this.write(`UPDATE notes SET ${V4_COLUMNS.map(([name, , from]) => `${name} = ${from}`).join(", ")}`);
    }
    if (version < 5) {
      const existing = new Set(this.sql.exec<{ name: string }>("SELECT name FROM pragma_table_info('notes')").toArray().map((c) => c.name));
      if (!existing.has("z")) this.sql.exec("ALTER TABLE notes ADD COLUMN z INTEGER NOT NULL DEFAULT 0");
      // Stacked as before: each note's place in creation order. Safe to repeat: it only runs below version 5.
      this.write("UPDATE notes SET z = (SELECT COUNT(*) FROM notes AS older WHERE older.rowid < notes.rowid)");
    }
    if (version < 6) {
      this.sql.exec(
        `CREATE TABLE IF NOT EXISTS frames (
          id TEXT PRIMARY KEY,
          x INTEGER NOT NULL DEFAULT 0,
          y INTEGER NOT NULL DEFAULT 0,
          w INTEGER NOT NULL DEFAULT ${FRAME_DEFAULT_W},
          h INTEGER NOT NULL DEFAULT ${FRAME_DEFAULT_H},
          title TEXT NOT NULL DEFAULT '',
          color TEXT NOT NULL DEFAULT 'neutral',
          rev INTEGER NOT NULL DEFAULT 1,
          author_id TEXT NOT NULL DEFAULT ''
        )`,
      );
    }
    if (version < 7) {
      const existing = new Set(this.sql.exec<{ name: string }>("SELECT name FROM pragma_table_info('frames')").toArray().map((c) => c.name));
      for (const [name, definition] of V7_FRAME_COLUMNS) {
        if (!existing.has(name)) this.sql.exec(`ALTER TABLE frames ADD COLUMN ${name} ${definition}`);
      }
    }
    if (version < 8) {
      this.sql.exec(
        `CREATE TABLE IF NOT EXISTS votes (
          voter_id TEXT NOT NULL DEFAULT '',
          note_id TEXT NOT NULL DEFAULT '',
          count INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (voter_id, note_id)
        )`,
      );
    }
    if (version < 9) this.sql.exec(SHAPES_TABLE);
    if (version < 10) {
      const existing = new Set(this.sql.exec<{ name: string }>("SELECT name FROM pragma_table_info('notes')").toArray().map((c) => c.name));
      if (!existing.has("sealed")) this.sql.exec("ALTER TABLE notes ADD COLUMN sealed INTEGER NOT NULL DEFAULT 0");
      if (!existing.has("writer")) this.sql.exec("ALTER TABLE notes ADD COLUMN writer TEXT DEFAULT NULL");
    }
    if (version < 11) this.sql.exec(REACTIONS_TABLE);
    if (version < 12) this.sql.exec(CONNECTORS_TABLE);
    this.write("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)", SCHEMA_VERSION);
  }

  /**
   * Every note, in creation order. Rows that don't validate are skipped, never fatal. A note
   * that older code left partly off the board at its size is clamped back on, and a z outside
   * the bound is clamped into it (in memory; saved with its next change).
   */
  private notes(): Map<string, Note> {
    if (this.cache) return this.cache;
    const cache = new Map<string, Note>();
    const writers = new Map<string, string>();
    for (const row of this.sql.exec<NoteRow>(`SELECT ${COLUMNS}, sealed, writer FROM notes ORDER BY rowid`)) {
      const rect = clampNoteRect({ x: row.x, y: row.y, w: row.w, h: row.h });
      const parsed = noteSchema.safeParse({
        id: row.id,
        ...rect,
        text: row.text,
        color: row.color,
        fontSize: row.font_size,
        bold: row.bold === 1,
        italic: row.italic === 1,
        textColor: row.text_color,
        align: row.align,
        titleAlign: row.title_align,
        titleFontSize: row.title_font_size,
        titleBold: row.title_bold === 1,
        titleItalic: row.title_italic === 1,
        titleTextColor: row.title_text_color,
        z: clampZ(row.z),
        rev: row.rev,
        authorId: row.author_id,
      });
      if (!parsed.success) continue;
      cache.set(parsed.data.id, parsed.data);
      if (row.sealed !== 0) writers.set(parsed.data.id, row.writer ?? "");
    }
    this.cache = cache;
    this.writers = writers;
    return cache;
  }

  all(): Note[] {
    return [...this.notes().values()];
  }

  get(id: string): Note | undefined {
    return this.notes().get(id);
  }

  get count(): number {
    return this.notes().size;
  }

  /** Saves a new note; with a writer (a silent round, schema 10) it is sealed. */
  insert(note: Note, writer: string | null = null): void {
    this.writeInsert(note, writer);
    this.notes().set(note.id, note);
    if (writer !== null) this.writers.set(note.id, writer);
  }

  private writeInsert(note: Note, writer: string | null): void {
    const row = [...values(note), writer === null ? 0 : 1, writer];
    this.write(`INSERT INTO notes (${COLUMNS}, sealed, writer) VALUES (${row.map(() => "?").join(", ")})`, ...row);
  }

  /* ── Sealed notes (schema 10, protocol v17) ──────────────────────────────────────────── */

  /** A sealed note's writer id ("" if it has none), or null when the note isn't sealed (or isn't here). */
  writerOf(id: string): string | null {
    this.notes();
    return this.writers.get(id) ?? this.goneWriters.get(id) ?? null;
  }

  /** Sealed notes in the room, everyone's. */
  get sealedCount(): number {
    this.notes();
    return this.writers.size;
  }

  /** A writer's sealed notes. */
  sealedBy(writer: string): number {
    this.notes();
    let count = 0;
    for (const w of this.writers.values()) if (w === writer) count++;
    return count;
  }

  /** A writer's sealed note ids, in creation order (protocol v18 silentMine). Never a writerless row's. */
  sealedIdsOf(writer: string): string[] {
    if (writer === "") return [];
    return [...this.notes().keys()].filter((id) => this.writers.get(id) === writer);
  }

  /** Whether any note is (or, during this message, was) sealed: the room filters outbound messages only then. */
  get hasSealed(): boolean {
    this.notes();
    return this.writers.size > 0 || this.goneWriters.size > 0;
  }

  /** Forgets the sealed notes deleted during the last message (the room calls it before each one). */
  forgetGone(): void {
    this.goneWriters.clear();
  }

  /**
   * The reveal: every sealed note becomes a normal one (sealed = 0, writer = NULL, one row each)
   * and the meta keys given are written, in one transaction. Returns the revealed notes in
   * creation order (unchanged, so a writer's copies keep their rev).
   */
  reveal(meta: Record<string, number | null>): Note[] {
    const notes = this.notes();
    const revealed = [...notes.values()].filter((n) => this.writers.has(n.id));
    this.transact(() => {
      if (revealed.length > 0) this.write("UPDATE notes SET sealed = 0, writer = NULL WHERE sealed <> 0");
      this.writeMeta(meta);
    });
    this.transactions += 1;
    this.writers = new Map();
    return revealed;
  }

  /** Deleted: remember its writer for the rest of this message (see goneWriters). */
  private forgetWriter(id: string): void {
    const writer = this.writers.get(id);
    if (writer === undefined) return;
    this.writers.delete(id);
    this.goneWriters.set(id, writer);
  }

  /** Saves a changed note (everything but its id and author). Keeps its place in creation order. */
  update(note: Note): void {
    this.writeUpdate(note);
    this.notes().set(note.id, note);
  }

  /**
   * A final batch (or a restack): every update and delete in one transaction, so it lands whole or not at all.
   * The cache changes only once it has committed.
   */
  applyBatch(updates: readonly Note[], deletes: readonly string[], shapeUpdates: readonly Shape[] = []): Connector[] {
    if (updates.length === 0 && deletes.length === 0 && shapeUpdates.length === 0) return [];
    // Connectors bound to a deleted note turn free (schema 12), in the same transaction.
    const detached = this.detachFrom(deletes);
    this.transact(() => {
      for (const note of updates) this.writeUpdate(note);
      for (const id of deletes) this.writeNoteDelete(id);
      // A restack over notes and shapes (one stacking space since v15) lands whole too.
      for (const shape of shapeUpdates) this.writeShapeUpdate(shape);
      for (const connector of detached) this.writeConnectorUpdate(connector);
    });
    this.transactions += 1;
    const shapes = this.shapes();
    for (const shape of shapeUpdates) shapes.set(shape.id, shape);
    const cache = this.notes();
    for (const note of updates) cache.set(note.id, note);
    for (const id of deletes) {
      cache.delete(id);
      this.forgetVotesOn(id);
      this.forgetReactionsOn(id);
      this.forgetWriter(id);
    }
    this.keepConnectors(detached);
    return detached;
  }

  /**
   * An itemsAdd: any renumbered notes and shapes (updates), then the new notes, frames and shapes,
   * in one transaction. Each insert writes 2 rows (the row and its primary-key index entry), as
   * insert, insertFrame and insertShape do. Caches change once it has committed. With a writer
   * (a silent round), the new notes are sealed.
   */
  applyAdds(
    updates: readonly Note[],
    notes: readonly Note[],
    frames: readonly Frame[],
    shapes: readonly Shape[] = [],
    shapeUpdates: readonly Shape[] = [],
    writer: string | null = null,
  ): void {
    if (updates.length === 0 && notes.length === 0 && frames.length === 0 && shapes.length === 0 && shapeUpdates.length === 0) return;
    this.transact(() => {
      for (const note of updates) this.writeUpdate(note);
      for (const shape of shapeUpdates) this.writeShapeUpdate(shape);
      for (const note of notes) this.writeInsert(note, writer);
      for (const frame of frames) this.writeFrameInsert(frame);
      for (const shape of shapes) this.writeShapeInsert(shape);
    });
    this.transactions += 1;
    const cache = this.notes();
    for (const note of [...updates, ...notes]) cache.set(note.id, note);
    if (writer !== null) for (const note of notes) this.writers.set(note.id, writer);
    const frameCache = this.frames();
    for (const frame of frames) frameCache.set(frame.id, frame);
    const shapeCache = this.shapes();
    for (const shape of [...shapeUpdates, ...shapes]) shapeCache.set(shape.id, shape);
  }

  private writeUpdate(note: Note): void {
    this.write(
      `UPDATE notes SET x = ?, y = ?, w = ?, h = ?, text = ?, color = ?, font_size = ?, bold = ?, italic = ?, text_color = ?, align = ?, title_align = ?,
       title_font_size = ?, title_bold = ?, title_italic = ?, title_text_color = ?, z = ?, rev = ?
       WHERE id = ?`,
      ...values(note).slice(1, -1),
      note.id,
    );
  }

  /**
   * Deletes a note, its votes (the dots go back to their voters) and its reactions, and turns the
   * connector ends bound to it free, in one transaction. Returns the connectors that changed.
   */
  delete(id: string): Connector[] {
    const detached = this.detachFrom([id]);
    this.transact(() => {
      this.writeNoteDelete(id);
      for (const connector of detached) this.writeConnectorUpdate(connector);
    });
    this.notes().delete(id);
    this.forgetVotesOn(id);
    this.forgetReactionsOn(id);
    this.forgetWriter(id);
    this.keepConnectors(detached);
    return detached;
  }

  /** Every note delete (single, batch, Clear board) goes through here: the note, its votes and its reactions. */
  private writeNoteDelete(id: string): void {
    this.write("DELETE FROM notes WHERE id = ?", id);
    this.write("DELETE FROM votes WHERE note_id = ?", id);
    this.write("DELETE FROM reactions WHERE note_id = ?", id);
  }

  /* ── Frames (schema 6; title style since 7) ──────────────────────────────────────────── */

  /** Every frame, in creation order. Bad rows are skipped; one off the board at its size is clamped back on. */
  private frames(): Map<string, Frame> {
    if (this.frameCache) return this.frameCache;
    const cache = new Map<string, Frame>();
    for (const row of this.sql.exec<FrameRow>(`SELECT ${FRAME_COLUMNS} FROM frames ORDER BY rowid`)) {
      const parsed = frameSchema.safeParse({
        id: row.id,
        ...clampFrameRect({ x: row.x, y: row.y, w: row.w, h: row.h }),
        title: row.title,
        color: row.color,
        titleFontSize: row.title_font_size,
        titleBold: row.title_bold === 1,
        titleItalic: row.title_italic === 1,
        titleTextColor: row.title_text_color,
        titleAlign: row.title_align,
        rev: row.rev,
        authorId: row.author_id,
      });
      if (parsed.success) cache.set(parsed.data.id, parsed.data);
    }
    this.frameCache = cache;
    return cache;
  }

  allFrames(): Frame[] {
    return [...this.frames().values()];
  }

  getFrame(id: string): Frame | undefined {
    return this.frames().get(id);
  }

  get frameCount(): number {
    return this.frames().size;
  }

  insertFrame(frame: Frame): void {
    this.writeFrameInsert(frame);
    this.frames().set(frame.id, frame);
  }

  private writeFrameInsert(frame: Frame): void {
    const row = frameValues(frame);
    this.write(`INSERT INTO frames (${FRAME_COLUMNS}) VALUES (${row.map(() => "?").join(", ")})`, ...row);
  }

  updateFrame(frame: Frame): void {
    this.writeFrameUpdate(frame);
    this.frames().set(frame.id, frame);
  }

  deleteFrame(id: string): void {
    this.write("DELETE FROM frames WHERE id = ?", id);
    this.frames().delete(id);
  }

  /**
   * A final frame move that carries notes and shapes: the frame (if it changed) and every changed
   * note and shape in one transaction, so they land together or not at all. Caches change once
   * it has committed.
   */
  applyFrameMove(frame: Frame | null, notes: readonly Note[], shapes: readonly Shape[] = []): void {
    if (!frame && notes.length === 0 && shapes.length === 0) return;
    this.transact(() => {
      if (frame) this.writeFrameUpdate(frame);
      for (const note of notes) this.writeUpdate(note);
      for (const shape of shapes) this.writeShapeUpdate(shape);
    });
    this.transactions += 1;
    if (frame) this.frames().set(frame.id, frame);
    const cache = this.notes();
    for (const note of notes) cache.set(note.id, note);
    const shapeCache = this.shapes();
    for (const shape of shapes) shapeCache.set(shape.id, shape);
  }

  private writeFrameUpdate(frame: Frame): void {
    this.write(
      `UPDATE frames SET x = ?, y = ?, w = ?, h = ?, title = ?, color = ?, rev = ?,
       title_font_size = ?, title_bold = ?, title_italic = ?, title_text_color = ?, title_align = ?
       WHERE id = ?`,
      ...frameUpdateValues(frame),
      frame.id,
    );
  }

  /* ── Shapes (schema 9, protocol v15) ─────────────────────────────────────────────────── */

  /**
   * Every shape, in creation order. Bad rows are skipped, never fatal; one off the board at its
   * size is clamped back on, and a z outside the bound clamped into it (in memory).
   */
  private shapes(): Map<string, Shape> {
    if (this.shapeCache) return this.shapeCache;
    const cache = new Map<string, Shape>();
    for (const row of this.sql.exec<ShapeRow>(`SELECT ${SHAPE_COLUMNS} FROM shapes ORDER BY rowid`)) {
      const parsed = shapeSchema.safeParse({
        id: row.id,
        kind: row.kind,
        ...clampShapeRect({ x: row.x, y: row.y, w: row.w, h: row.h }),
        text: row.text,
        fill: row.fill,
        stroke: row.stroke,
        strokeWidth: row.stroke_width,
        strokeStyle: row.stroke_style,
        fontSize: row.font_size,
        bold: row.bold === 1,
        italic: row.italic === 1,
        underline: row.underline === 1,
        textColor: row.text_color,
        align: row.align,
        valign: row.valign,
        z: clampZ(row.z),
        rev: row.rev,
        authorId: row.author_id,
      });
      if (parsed.success) cache.set(parsed.data.id, parsed.data);
    }
    this.shapeCache = cache;
    return cache;
  }

  allShapes(): Shape[] {
    return [...this.shapes().values()];
  }

  getShape(id: string): Shape | undefined {
    return this.shapes().get(id);
  }

  get shapeCount(): number {
    return this.shapes().size;
  }

  insertShape(shape: Shape): void {
    this.writeShapeInsert(shape);
    this.shapes().set(shape.id, shape);
  }

  updateShape(shape: Shape): void {
    this.writeShapeUpdate(shape);
    this.shapes().set(shape.id, shape);
  }

  /** Deletes a shape and turns the connector ends bound to it free, in one transaction. Returns the connectors that changed. */
  deleteShape(id: string): Connector[] {
    const detached = this.detachFrom([id]);
    this.transact(() => {
      this.writeShapeDelete(id);
      for (const connector of detached) this.writeConnectorUpdate(connector);
    });
    this.shapes().delete(id);
    this.keepConnectors(detached);
    return detached;
  }

  /**
   * A final shapeBatch: every update and delete, and the connector ends bound to a deleted shape
   * turned free, in one transaction. Caches change once it has committed. Returns the connectors that changed.
   */
  applyShapeBatch(updates: readonly Shape[], deletes: readonly string[]): Connector[] {
    if (updates.length === 0 && deletes.length === 0) return [];
    const detached = this.detachFrom(deletes);
    this.transact(() => {
      for (const shape of updates) this.writeShapeUpdate(shape);
      for (const id of deletes) this.writeShapeDelete(id);
      for (const connector of detached) this.writeConnectorUpdate(connector);
    });
    this.transactions += 1;
    const cache = this.shapes();
    for (const shape of updates) cache.set(shape.id, shape);
    for (const id of deletes) cache.delete(id);
    this.keepConnectors(detached);
    return detached;
  }

  private writeShapeInsert(shape: Shape): void {
    const row = shapeValues(shape);
    this.write(`INSERT INTO shapes (${SHAPE_COLUMNS}) VALUES (${row.map(() => "?").join(", ")})`, ...row);
  }

  /** Everything but the id, kind and author (the kind never changes). */
  private writeShapeUpdate(shape: Shape): void {
    this.write(
      `UPDATE shapes SET x = ?, y = ?, w = ?, h = ?, text = ?, fill = ?, stroke = ?, stroke_width = ?, stroke_style = ?, font_size = ?,
       bold = ?, italic = ?, underline = ?, text_color = ?, align = ?, valign = ?, z = ?, rev = ?
       WHERE id = ?`,
      ...shapeValues(shape).slice(2, -1),
      shape.id,
    );
  }

  private writeShapeDelete(id: string): void {
    this.write("DELETE FROM shapes WHERE id = ?", id);
  }

  /* ── Connectors (schema 12, protocol v21) ────────────────────────────────────────────── */

  /**
   * Every connector, in creation order. Rows that don't validate are skipped, never fatal; a free
   * end off the board is clamped back on (in memory). A connector bound to an item that isn't here
   * (version 11 code deleted it after a rollback) or to a sealed note (never written by us) is
   * skipped too, so a snapshot never names one.
   */
  private connectors(): Map<string, Connector> {
    if (this.connectorCache) return this.connectorCache;
    const notes = this.notes();
    const shapes = this.shapes();
    const bindable = (item: string) => (notes.has(item) && !this.writers.has(item)) || shapes.has(item);
    const end = (item: string | null, anchor: string | null, x: number | null, y: number | null): unknown => {
      if (item !== null) return { item, anchor };
      return x !== null && y !== null ? clampConnectorPoint(x, y) : null;
    };
    const cache = new Map<string, Connector>();
    for (const row of this.sql.exec<ConnectorRow>(`SELECT ${CONNECTOR_COLUMNS} FROM connectors ORDER BY rowid`)) {
      const parsed = connectorSchema.safeParse({
        id: row.id,
        start: end(row.start_item, row.start_anchor, row.start_x, row.start_y),
        end: end(row.end_item, row.end_anchor, row.end_x, row.end_y),
        route: row.route,
        dash: row.dash,
        width: row.width,
        ink: row.ink,
        startHead: row.start_head,
        endHead: row.end_head,
        rev: row.rev,
        authorId: row.author_id,
      });
      if (!parsed.success) continue;
      const { start, end: last } = parsed.data;
      if ((isBound(start) && !bindable(start.item)) || (isBound(last) && !bindable(last.item))) continue;
      cache.set(parsed.data.id, parsed.data);
    }
    this.connectorCache = cache;
    return cache;
  }

  allConnectors(): Connector[] {
    return [...this.connectors().values()];
  }

  getConnector(id: string): Connector | undefined {
    return this.connectors().get(id);
  }

  get connectorCount(): number {
    return this.connectors().size;
  }

  /** A note (not sealed) or shape's box, for binding and anchor points; undefined for anything else. */
  boxOf(item: string): Box | undefined {
    const note = this.notes().get(item);
    if (note) return this.writers.has(item) ? undefined : note;
    return this.shapes().get(item);
  }

  insertConnector(connector: Connector): void {
    const row = connectorValues(connector);
    this.write(`INSERT INTO connectors (${CONNECTOR_COLUMNS}) VALUES (${row.map(() => "?").join(", ")})`, ...row);
    this.connectors().set(connector.id, connector);
  }

  updateConnector(connector: Connector): void {
    this.writeConnectorUpdate(connector);
    this.connectors().set(connector.id, connector);
  }

  deleteConnector(id: string): void {
    this.write("DELETE FROM connectors WHERE id = ?", id);
    this.connectors().delete(id);
  }

  /** Everything but the id and author. */
  private writeConnectorUpdate(connector: Connector): void {
    this.write(
      `UPDATE connectors SET start_item = ?, start_anchor = ?, start_x = ?, start_y = ?, end_item = ?, end_anchor = ?, end_x = ?, end_y = ?,
       route = ?, dash = ?, width = ?, ink = ?, start_head = ?, end_head = ?, rev = ? WHERE id = ?`,
      ...connectorValues(connector).slice(1, -1),
      connector.id,
    );
  }

  /**
   * The delete rule: the connectors with an end bound to one of these items (about to be deleted),
   * each with those ends turned free at their last anchor point (anchorPoint on the item's box as
   * it is now, aimed at the other end's reference point, rounded and clamped) and one rev bump.
   * Pure over the caches: the caller writes them in its delete's transaction, then keepConnectors.
   */
  private detachFrom(items: readonly string[]): Connector[] {
    if (items.length === 0) return [];
    const gone = new Set(items);
    const boxOf = (item: string) => this.boxOf(item);
    const freed = (end: ConnectorEnd, other: ConnectorEnd): ConnectorEnd => {
      if (!isBound(end) || !gone.has(end.item)) return end;
      const box = boxOf(end.item);
      const aim = endReference(other, boxOf);
      if (!box || !aim) return end;
      const point = anchorPoint(box, end.anchor, aim);
      return clampConnectorPoint(point.x, point.y);
    };
    const detached: Connector[] = [];
    for (const connector of this.connectors().values()) {
      const bound = [connector.start, connector.end].some((end) => isBound(end) && gone.has(end.item));
      if (!bound) continue;
      detached.push({ ...connector, start: freed(connector.start, connector.end), end: freed(connector.end, connector.start), rev: connector.rev + 1 });
    }
    return detached;
  }

  /** Detached connectors into the cache, once their transaction has committed. */
  private keepConnectors(connectors: readonly Connector[]): void {
    if (connectors.length === 0) return;
    const cache = this.connectors();
    for (const connector of connectors) cache.set(connector.id, connector);
  }

  /* ── Room settings in meta (protocol v12: locked, timer_started_at, timer_duration_ms) ── */

  /** A meta value, or null when the key isn't there. */
  getMeta(key: string): number | null {
    const row = this.sql.exec<{ value: number }>("SELECT value FROM meta WHERE key = ?", key).toArray()[0];
    return row ? row.value : null;
  }

  /** Sets meta keys (and deletes those given null) in one transaction. Callers write only when something changed. */
  setMeta(values: Record<string, number | null>): void {
    this.transact(() => this.writeMeta(values));
  }

  private writeMeta(values: Record<string, number | null>): void {
    for (const [key, value] of Object.entries(values)) {
      if (value === null) this.write("DELETE FROM meta WHERE key = ?", key);
      else this.write("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
    }
  }

  /* ── Votes (schema 8, protocol v13) ──────────────────────────────────────────────────── */

  /**
   * Every vote, by voter then note. Rows for notes that aren't here (left by older code) or with
   * a count outside 1..VOTE_BUDGET_MAX are skipped, never fatal.
   */
  private votes(): Map<string, Map<string, number>> {
    if (this.voteCache) return this.voteCache;
    const notes = this.notes();
    const cache = new Map<string, Map<string, number>>();
    for (const row of this.sql.exec<{ voter_id: string; note_id: string; count: number }>("SELECT voter_id, note_id, count FROM votes ORDER BY rowid")) {
      if (!notes.has(row.note_id) || !Number.isInteger(row.count) || row.count < 1 || row.count > VOTE_BUDGET_MAX) continue;
      const mine = cache.get(row.voter_id) ?? new Map<string, number>();
      mine.set(row.note_id, row.count);
      cache.set(row.voter_id, mine);
    }
    this.voteCache = cache;
    return cache;
  }

  /** A voter's votes, in note creation order. */
  votesOf(voterId: string): { noteId: string; count: number }[] {
    const mine = this.votes().get(voterId);
    if (!mine) return [];
    return [...this.notes().keys()].flatMap((noteId) => {
      const count = mine.get(noteId);
      return count ? [{ noteId, count }] : [];
    });
  }

  /** Dots a voter has placed. */
  usedBy(voterId: string): number {
    let used = 0;
    for (const count of this.votes().get(voterId)?.values() ?? []) used += count;
    return used;
  }

  /** Voters with at least one vote. */
  voterIds(): Set<string> {
    return new Set(this.votes().keys());
  }

  /** Sets one voter's dots on a note (0 deletes the row). Writes only when it changes; returns whether it did. */
  setVote(voterId: string, noteId: string, count: number): boolean {
    const votes = this.votes();
    const mine = votes.get(voterId);
    if ((mine?.get(noteId) ?? 0) === count) return false;
    if (count === 0) {
      this.write("DELETE FROM votes WHERE voter_id = ? AND note_id = ?", voterId, noteId);
      mine?.delete(noteId);
      if (mine?.size === 0) votes.delete(voterId);
    } else {
      this.write(
        "INSERT INTO votes (voter_id, note_id, count) VALUES (?, ?, ?) ON CONFLICT(voter_id, note_id) DO UPDATE SET count = excluded.count",
        voterId,
        noteId,
        count,
      );
      votes.set(voterId, (mine ?? new Map<string, number>()).set(noteId, count));
    }
    return true;
  }

  /** Every note's total, non-zero only, in note creation order. Totals only: never who. */
  totals(): { noteId: string; count: number }[] {
    const sums = new Map<string, number>();
    for (const mine of this.votes().values()) for (const [noteId, count] of mine) sums.set(noteId, (sums.get(noteId) ?? 0) + count);
    return [...this.notes().keys()].flatMap((noteId) => {
      const count = sums.get(noteId) ?? 0;
      return count > 0 ? [{ noteId, count }] : [];
    });
  }

  /**
   * Voting state changes: meta keys (null deletes) and, with `clearVotes`, every vote deleted, in
   * one transaction. Callers pass only what changed.
   */
  setVoting(values: Record<string, number | null>, clearVotes: boolean): void {
    this.transact(() => {
      if (clearVotes) this.write("DELETE FROM votes");
      this.writeMeta(values);
    });
    if (clearVotes) this.voteCache = new Map();
  }

  private forgetVotesOn(noteId: string): void {
    for (const [voterId, mine] of this.votes()) {
      mine.delete(noteId);
      if (mine.size === 0) this.votes().delete(voterId);
    }
  }

  /* ── Reactions (schema 11, protocol v20) ─────────────────────────────────────────────── */

  /**
   * Every reaction, by note then key. Rows for notes that aren't here (left by older code) or with
   * a key outside REACTION_KEYS are skipped, never fatal, and don't count towards the caps.
   */
  private reactions(): Map<string, Map<ReactionKey, Set<string>>> {
    if (this.reactionCache) return this.reactionCache;
    const notes = this.notes();
    const cache = new Map<string, Map<ReactionKey, Set<string>>>();
    const totals = new Map<string, number>();
    let total = 0;
    for (const row of this.sql.exec<{ reactor_id: string; note_id: string; reaction_key: string }>("SELECT reactor_id, note_id, reaction_key FROM reactions ORDER BY rowid")) {
      if (!notes.has(row.note_id) || !isReactionKey(row.reaction_key) || row.reactor_id === "") continue;
      const byKey = cache.get(row.note_id) ?? new Map<ReactionKey, Set<string>>();
      const reactors = byKey.get(row.reaction_key) ?? new Set<string>();
      reactors.add(row.reactor_id);
      byKey.set(row.reaction_key, reactors);
      cache.set(row.note_id, byKey);
      totals.set(row.reactor_id, (totals.get(row.reactor_id) ?? 0) + 1);
      total++;
    }
    this.reactionCache = cache;
    this.reactorTotals = totals;
    this.reactionTotal = total;
    return cache;
  }

  /** Reaction rows in the room (the room cap counts these). */
  get reactionRows(): number {
    this.reactions();
    return this.reactionTotal;
  }

  /** Reactions a reactor has on (the reactor cap counts these). */
  reactionsBy(reactor: string): number {
    this.reactions();
    return this.reactorTotals.get(reactor) ?? 0;
  }

  /** Whether this reactor has this reaction on this note. */
  hasReaction(reactor: string, noteId: string, key: ReactionKey): boolean {
    return this.reactions().get(noteId)?.get(key)?.has(reactor) ?? false;
  }

  /** Everyone's count for a note and key. */
  reactionCount(noteId: string, key: ReactionKey): number {
    return this.reactions().get(noteId)?.get(key)?.size ?? 0;
  }

  /**
   * Sets one reactor's reaction on or off: a row inserted (on) or deleted (off). Writes only when it
   * changes; returns whether it did. Callers check the note and the caps first.
   */
  setReaction(reactor: string, noteId: string, key: ReactionKey, on: boolean): boolean {
    if (this.hasReaction(reactor, noteId, key) === on) return false;
    const cache = this.reactions();
    if (on) {
      this.write("INSERT INTO reactions (reactor_id, note_id, reaction_key) VALUES (?, ?, ?)", reactor, noteId, key);
      const byKey = cache.get(noteId) ?? new Map<ReactionKey, Set<string>>();
      byKey.set(key, (byKey.get(key) ?? new Set<string>()).add(reactor));
      cache.set(noteId, byKey);
      this.countReaction(reactor, 1);
    } else {
      this.write("DELETE FROM reactions WHERE reactor_id = ? AND note_id = ? AND reaction_key = ?", reactor, noteId, key);
      const byKey = cache.get(noteId);
      const reactors = byKey?.get(key);
      reactors?.delete(reactor);
      if (reactors?.size === 0) byKey?.delete(key);
      if (byKey?.size === 0) cache.delete(noteId);
      this.countReaction(reactor, -1);
    }
    return true;
  }

  /**
   * Every non-zero count, in note creation order then REACTION_KEYS order. Never a sealed note's
   * (anyone's, its writer's included): counts only, never who.
   */
  reactionCounts(): { noteId: string; key: ReactionKey; count: number }[] {
    const cache = this.reactions();
    return [...this.notes().keys()].flatMap((noteId) => {
      const byKey = cache.get(noteId);
      if (!byKey || this.writers.has(noteId)) return [];
      return REACTION_KEYS.flatMap((key) => {
        const count = byKey.get(key)?.size ?? 0;
        return count > 0 ? [{ noteId, key, count }] : [];
      });
    });
  }

  /** A reactor's own reactions, in the same order. Never on a sealed note. */
  reactionsOf(reactor: string): { noteId: string; key: ReactionKey }[] {
    const cache = this.reactions();
    return [...this.notes().keys()].flatMap((noteId) => {
      const byKey = cache.get(noteId);
      if (!byKey || this.writers.has(noteId)) return [];
      return REACTION_KEYS.flatMap((key) => (byKey.get(key)?.has(reactor) ? [{ noteId, key }] : []));
    });
  }

  private countReaction(reactor: string, by: number): void {
    const next = (this.reactorTotals.get(reactor) ?? 0) + by;
    if (next > 0) this.reactorTotals.set(reactor, next);
    else this.reactorTotals.delete(reactor);
    this.reactionTotal += by;
  }

  /** A deleted note's reactions leave the caches (its rows went in the delete's transaction). */
  private forgetReactionsOn(noteId: string): void {
    const byKey = this.reactions().get(noteId);
    if (!byKey) return;
    for (const reactors of byKey.values()) for (const reactor of reactors) this.countReaction(reactor, -1);
    this.reactions().delete(noteId);
  }

  private write(query: string, ...bindings: SqlStorageValue[]): void {
    const cursor = this.sql.exec(query, ...bindings);
    cursor.toArray();
    this.rowsWritten += cursor.rowsWritten;
  }
}

/** A note's column values, in COLUMNS order. */
function values(n: Note): SqlStorageValue[] {
  return [
    n.id, n.x, n.y, n.w, n.h, n.text, n.color,
    n.fontSize, Number(n.bold), Number(n.italic), n.textColor, n.align,
    n.titleAlign, n.titleFontSize, Number(n.titleBold), Number(n.titleItalic), n.titleTextColor,
    n.z, n.rev, n.authorId,
  ];
}

/** A shape's column values, in SHAPE_COLUMNS order. */
function shapeValues(s: Shape): SqlStorageValue[] {
  return [
    s.id, s.kind, s.x, s.y, s.w, s.h, s.text, s.fill, s.stroke, s.strokeWidth, s.strokeStyle, s.fontSize,
    Number(s.bold), Number(s.italic), Number(s.underline), s.textColor, s.align, s.valign, s.z, s.rev, s.authorId,
  ];
}

/** A connector's column values, in CONNECTOR_COLUMNS order: a bound end's item and anchor, or a free end's x and y (the others NULL). */
function connectorValues(k: Connector): SqlStorageValue[] {
  const end = (e: ConnectorEnd): SqlStorageValue[] => (isBound(e) ? [e.item, e.anchor, null, null] : [null, null, e.x, e.y]);
  return [k.id, ...end(k.start), ...end(k.end), k.route, k.dash, k.width, k.ink, k.startHead, k.endHead, k.rev, k.authorId];
}

/** A frame's column values, in FRAME_COLUMNS order. */
function frameValues(f: Frame): SqlStorageValue[] {
  return [f.id, f.x, f.y, f.w, f.h, f.title, f.color, f.rev, f.authorId, ...frameStyleValues(f)];
}

/** The values for writeFrameUpdate's SET list, in order. */
function frameUpdateValues(f: Frame): SqlStorageValue[] {
  return [f.x, f.y, f.w, f.h, f.title, f.color, f.rev, ...frameStyleValues(f)];
}

function frameStyleValues(f: Frame): SqlStorageValue[] {
  return [f.titleFontSize, Number(f.titleBold), Number(f.titleItalic), f.titleTextColor, f.titleAlign];
}
