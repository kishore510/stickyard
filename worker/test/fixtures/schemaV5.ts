/*
 * A room database as slice z-order left it (schema version 5, protocol v8): notes with z, and no
 * frames table. Statements are exactly what that NoteStore ran (the version 4 tables, then z).
 * Generic text.
 */

export const V5_NOTES = [
  { id: "v5note0000000001", x: 0, y: 0, w: 160, h: 160, text: "Start\nKeep doing", color: "yellow", z: 0, rev: 1 },
  { id: "v5note0000000002", x: 40, y: 40, w: 300, h: 200, text: "Stop", color: "blue", z: 5, rev: 4 },
  { id: "v5note0000000003", x: 80, y: 80, w: 96, h: 96, text: "Continue", color: "pink", z: -2, rev: 2 },
] as const;

const V5_COLUMNS =
  "id, x, y, w, h, text, color, font_size, bold, italic, text_color, align, title_align, title_font_size, title_bold, title_italic, title_text_color, z, rev, author_id";

/** Replaces whatever the room has with a version 5 database holding V5_NOTES. */
export function loadSchemaV5(sql: SqlStorage): void {
  sql.exec("DROP TABLE IF EXISTS notes");
  sql.exec("DROP TABLE IF EXISTS meta");
  // Schema 5 has no frames table.
  sql.exec("DROP TABLE IF EXISTS frames");
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
  sql.exec("ALTER TABLE notes ADD COLUMN z INTEGER NOT NULL DEFAULT 0");
  sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)", 5);
  for (const n of V5_NOTES) {
    sql.exec(V5_INSERT, n.id, n.x, n.y, n.w, n.h, n.text, n.color, "m", 0, 0, "auto", "left", "left", "m", 0, 0, "auto", n.z, n.rev, "AAAAAAAAAAAAAAAA");
  }
}

/** The statements a version 5 (protocol v8) NoteStore runs to save notes: rollback safety tests run them on schema 6. */
export const V5_INSERT = `INSERT INTO notes (${V5_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
export const V5_UPDATE = `UPDATE notes SET x = ?, y = ?, w = ?, h = ?, text = ?, color = ?, font_size = ?, bold = ?, italic = ?, text_color = ?, align = ?, title_align = ?,
       title_font_size = ?, title_bold = ?, title_italic = ?, title_text_color = ?, z = ?, rev = ?
       WHERE id = ?`;
