/*
 * A room database as slice 2.7.2 left it (schema version 4, protocol v6 and v7): no z, so notes
 * are stacked in creation (rowid) order. Statements are exactly what that NoteStore ran (version
 * 1 table, the version 2 columns, title_align, then the version 4 title columns). Rows are
 * inserted out of id order on purpose, so the backfill must follow rowid, not id. Generic text.
 */

export const V4_NOTES = [
  { id: "v4note0000000003", x: 0, y: 0, w: 160, h: 160, text: "First added\nAt the bottom", color: "yellow", rev: 1 },
  { id: "v4note0000000001", x: 40, y: 40, w: 300, h: 200, text: "Second", color: "blue", rev: 4 },
  { id: "v4note0000000002", x: 80, y: 80, w: 96, h: 96, text: "Last added\nOn top", color: "pink", rev: 2 },
] as const;

const V4_COLUMNS =
  "id, x, y, w, h, text, color, font_size, bold, italic, text_color, align, title_align, title_font_size, title_bold, title_italic, title_text_color, rev, author_id";

/** Replaces whatever the room has with a version 4 database holding V4_NOTES (in that order). */
export function loadSchemaV4(sql: SqlStorage): void {
  sql.exec("DROP TABLE IF EXISTS notes");
  sql.exec("DROP TABLE IF EXISTS meta");
  sql.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL)");
  sql.exec(
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
  sql.exec("ALTER TABLE notes ADD COLUMN w INTEGER NOT NULL DEFAULT 160");
  sql.exec("ALTER TABLE notes ADD COLUMN h INTEGER NOT NULL DEFAULT 160");
  sql.exec("ALTER TABLE notes ADD COLUMN font_size TEXT NOT NULL DEFAULT 'm'");
  sql.exec("ALTER TABLE notes ADD COLUMN bold INTEGER NOT NULL DEFAULT 0");
  sql.exec("ALTER TABLE notes ADD COLUMN italic INTEGER NOT NULL DEFAULT 0");
  sql.exec("ALTER TABLE notes ADD COLUMN text_color TEXT NOT NULL DEFAULT 'auto'");
  sql.exec("ALTER TABLE notes ADD COLUMN align TEXT NOT NULL DEFAULT 'left'");
  sql.exec("ALTER TABLE notes ADD COLUMN title_align TEXT NOT NULL DEFAULT 'left'");
  sql.exec("ALTER TABLE notes ADD COLUMN title_font_size TEXT NOT NULL DEFAULT 'm'");
  sql.exec("ALTER TABLE notes ADD COLUMN title_bold INTEGER NOT NULL DEFAULT 0");
  sql.exec("ALTER TABLE notes ADD COLUMN title_italic INTEGER NOT NULL DEFAULT 0");
  sql.exec("ALTER TABLE notes ADD COLUMN title_text_color TEXT NOT NULL DEFAULT 'auto'");
  sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)", 4);
  for (const n of V4_NOTES) {
    sql.exec(V4_INSERT, n.id, n.x, n.y, n.w, n.h, n.text, n.color, "m", 0, 0, "auto", "left", "left", "m", 0, 0, "auto", n.rev, "AAAAAAAAAAAAAAAA");
  }
}

/** The statements a version 4 (protocol v6/v7) NoteStore runs to save notes: rollback safety tests run them on schema 5. */
export const V4_INSERT = `INSERT INTO notes (${V4_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
export const V4_UPDATE = `UPDATE notes SET x = ?, y = ?, w = ?, h = ?, text = ?, color = ?, font_size = ?, bold = ?, italic = ?, text_color = ?, align = ?, title_align = ?,
       title_font_size = ?, title_bold = ?, title_italic = ?, title_text_color = ?, rev = ?
       WHERE id = ?`;
