/*
 * A room database as slice 2.7.1 (schema version 3, protocol v5) left it: one size, weight,
 * slant and ink for the whole note, alignment per part. Statements are exactly what that
 * NoteStore ran (version 1 table, the version 2 columns, then title_align). Generic text.
 */

export const V3_NOTES = [
  { id: "v3note0000000001", x: 0, y: 0, w: 160, h: 160, text: "Idea one\nThe details", color: "yellow", font_size: "m", bold: 0, italic: 0, text_color: "auto", align: "left", title_align: "left", rev: 1, author_id: "AAAAAAAAAAAAAAAA" },
  { id: "v3note0000000002", x: 400, y: 300, w: 300, h: 200, text: "Big\nBold blue", color: "blue", font_size: "xl", bold: 1, italic: 0, text_color: "blue", align: "center", title_align: "right", rev: 4, author_id: "BBBBBBBBBBBBBBBB" },
  { id: "v3note0000000003", x: 900, y: 600, w: 96, h: 96, text: "Small", color: "pink", font_size: "s", bold: 0, italic: 1, text_color: "red", align: "right", title_align: "right", rev: 2, author_id: "AAAAAAAAAAAAAAAA" },
] as const;

const V3_COLUMNS = "id, x, y, w, h, text, color, font_size, bold, italic, text_color, align, title_align, rev, author_id";

/** Replaces whatever the room has with a version 3 database holding V3_NOTES. */
export function loadSchemaV3(sql: SqlStorage): void {
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
  sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)", 3);
  for (const n of V3_NOTES) {
    sql.exec(
      `INSERT INTO notes (${V3_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      n.id, n.x, n.y, n.w, n.h, n.text, n.color, n.font_size, n.bold, n.italic, n.text_color, n.align, n.title_align, n.rev, n.author_id,
    );
  }
}

/** The statements a version 3 (protocol v5) NoteStore runs to save notes: rollback safety tests run them on schema 4. */
export const V3_INSERT = `INSERT INTO notes (${V3_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
export const V3_UPDATE = `UPDATE notes SET x = ?, y = ?, w = ?, h = ?, text = ?, color = ?, font_size = ?, bold = ?, italic = ?, text_color = ?, align = ?, title_align = ?, rev = ?
       WHERE id = ?`;
