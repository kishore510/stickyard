import { FRAME_DEFAULTS, FRAME_DEFAULT_H, FRAME_DEFAULT_W, NOTE_DEFAULTS, clampFrameRect, clampNoteRect, clampZ, frameSchema, noteSchema, type Frame, type Note } from "@stickyard/shared";

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
 */
export const SCHEMA_VERSION = 7;

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
    for (const row of this.sql.exec<NoteRow>(`SELECT ${COLUMNS} FROM notes ORDER BY rowid`)) {
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
      if (parsed.success) cache.set(parsed.data.id, parsed.data);
    }
    this.cache = cache;
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

  insert(note: Note): void {
    this.writeInsert(note);
    this.notes().set(note.id, note);
  }

  private writeInsert(note: Note): void {
    const row = values(note);
    this.write(`INSERT INTO notes (${COLUMNS}) VALUES (${row.map(() => "?").join(", ")})`, ...row);
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
  applyBatch(updates: readonly Note[], deletes: readonly string[]): void {
    if (updates.length === 0 && deletes.length === 0) return;
    this.transact(() => {
      for (const note of updates) this.writeUpdate(note);
      for (const id of deletes) this.write("DELETE FROM notes WHERE id = ?", id);
    });
    this.transactions += 1;
    const cache = this.notes();
    for (const note of updates) cache.set(note.id, note);
    for (const id of deletes) cache.delete(id);
  }

  /**
   * An itemsAdd: any renumbered notes (updates), then the new notes and frames, in one
   * transaction. Each insert writes 2 rows (the row and its primary-key index entry), as insert
   * and insertFrame do. Caches change once it has committed.
   */
  applyAdds(updates: readonly Note[], notes: readonly Note[], frames: readonly Frame[]): void {
    if (updates.length === 0 && notes.length === 0 && frames.length === 0) return;
    this.transact(() => {
      for (const note of updates) this.writeUpdate(note);
      for (const note of notes) this.writeInsert(note);
      for (const frame of frames) this.writeFrameInsert(frame);
    });
    this.transactions += 1;
    const cache = this.notes();
    for (const note of [...updates, ...notes]) cache.set(note.id, note);
    const frameCache = this.frames();
    for (const frame of frames) frameCache.set(frame.id, frame);
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

  delete(id: string): void {
    this.write("DELETE FROM notes WHERE id = ?", id);
    this.notes().delete(id);
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
   * A final frame move that carries notes: the frame (if it changed) and every changed note in
   * one transaction, so they land together or not at all. Caches change once it has committed.
   */
  applyFrameMove(frame: Frame | null, notes: readonly Note[]): void {
    if (!frame && notes.length === 0) return;
    this.transact(() => {
      if (frame) this.writeFrameUpdate(frame);
      for (const note of notes) this.writeUpdate(note);
    });
    this.transactions += 1;
    if (frame) this.frames().set(frame.id, frame);
    const cache = this.notes();
    for (const note of notes) cache.set(note.id, note);
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
