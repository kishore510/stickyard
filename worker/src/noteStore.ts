import { noteSchema, type Note } from "@stickyard/shared";

/**
 * A room's notes, in its Durable Object's SQLite. Written only on commits (add, edit, final
 * move, delete), never per drag message. Held in memory once loaded, so reads after the
 * first are free; loaded again when the object wakes from hibernation.
 *
 * Schema versions (bump SCHEMA_VERSION and add a step to `migrate` for any change):
 *   1 (slice 2): meta(key, value) and notes(id, x, y, text, color, rev, author_id).
 */
export const SCHEMA_VERSION = 1;

interface NoteRow extends Record<string, SqlStorageValue> {
  id: string;
  x: number;
  y: number;
  text: string;
  color: string;
  rev: number;
  author_id: string;
}

export class NoteStore {
  /** Rows written by this instance. Tests use it to prove drags don't write. */
  rowsWritten = 0;
  private cache: Map<string, Note> | null = null;

  constructor(private readonly sql: SqlStorage) {
    this.migrate();
  }

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
    this.write("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)", SCHEMA_VERSION);
  }

  /** Every note, in creation order. Rows that don't validate are skipped, never fatal. */
  private notes(): Map<string, Note> {
    if (this.cache) return this.cache;
    const cache = new Map<string, Note>();
    for (const row of this.sql.exec<NoteRow>("SELECT id, x, y, text, color, rev, author_id FROM notes ORDER BY rowid")) {
      const parsed = noteSchema.safeParse({ ...row, authorId: row.author_id });
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
    this.write(
      "INSERT INTO notes (id, x, y, text, color, rev, author_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
      note.id,
      note.x,
      note.y,
      note.text,
      note.color,
      note.rev,
      note.authorId,
    );
    this.notes().set(note.id, note);
  }

  /** Saves a changed note (its position, text and rev). Keeps its place in creation order. */
  update(note: Note): void {
    this.write("UPDATE notes SET x = ?, y = ?, text = ?, rev = ? WHERE id = ?", note.x, note.y, note.text, note.rev, note.id);
    this.notes().set(note.id, note);
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
