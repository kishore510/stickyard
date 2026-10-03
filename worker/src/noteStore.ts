import { NOTE_DEFAULTS, clampNoteRect, noteSchema, type Note } from "@stickyard/shared";

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
 */
export const SCHEMA_VERSION = 4;

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
  rev: number;
  author_id: string;
}

const COLUMNS =
  "id, x, y, w, h, text, color, font_size, bold, italic, text_color, align, title_align, title_font_size, title_bold, title_italic, title_text_color, rev, author_id";

/** Runs `fn` as one SQLite transaction (the Durable Object's transactionSync). */
export type Transact = (fn: () => void) => void;

export class NoteStore {
  /** Rows written by this instance. Tests use it to prove drags and resizes don't write. */
  rowsWritten = 0;
  /** Batch transactions committed by this instance (tests check a final batch is one). */
  transactions = 0;
  private cache: Map<string, Note> | null = null;

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
    this.write("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)", SCHEMA_VERSION);
  }

  /**
   * Every note, in creation order. Rows that don't validate are skipped, never fatal. A note
   * that older code left partly off the board at its size is clamped back on (in memory; it's
   * saved with its next change).
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
    const row = values(note);
    this.write(`INSERT INTO notes (${COLUMNS}) VALUES (${row.map(() => "?").join(", ")})`, ...row);
    this.notes().set(note.id, note);
  }

  /** Saves a changed note (everything but its id and author). Keeps its place in creation order. */
  update(note: Note): void {
    this.writeUpdate(note);
    this.notes().set(note.id, note);
  }

  /**
   * A final batch: every update and delete in one transaction, so it lands whole or not at all.
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

  private writeUpdate(note: Note): void {
    this.write(
      `UPDATE notes SET x = ?, y = ?, w = ?, h = ?, text = ?, color = ?, font_size = ?, bold = ?, italic = ?, text_color = ?, align = ?, title_align = ?,
       title_font_size = ?, title_bold = ?, title_italic = ?, title_text_color = ?, rev = ?
       WHERE id = ?`,
      ...values(note).slice(1, -1),
      note.id,
    );
  }

  delete(id: string): void {
    this.write("DELETE FROM notes WHERE id = ?", id);
    this.notes().delete(id);
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
    n.rev, n.authorId,
  ];
}
