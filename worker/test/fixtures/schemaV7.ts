import { V5_INSERT } from "./schemaV5";
import { loadSchemaV6 } from "./schemaV6";

/*
 * A room database as slice frame title styling left it (schema version 7, protocols v10 to v12):
 * the version 6 notes and frames, the frames' title style columns, and no votes table. Statements
 * are exactly what that NoteStore ran. Protocol v12 also kept `locked` and the timer in meta.
 */

/** Replaces whatever the room has with a version 7 database (the version 5 notes, the version 6 frames). */
export function loadSchemaV7(sql: SqlStorage): void {
  // Schema 7 has no votes table.
  sql.exec("DROP TABLE IF EXISTS votes");
  loadSchemaV6(sql);
  sql.exec("ALTER TABLE frames ADD COLUMN title_font_size TEXT NOT NULL DEFAULT 'm'");
  sql.exec("ALTER TABLE frames ADD COLUMN title_bold INTEGER NOT NULL DEFAULT 1");
  sql.exec("ALTER TABLE frames ADD COLUMN title_italic INTEGER NOT NULL DEFAULT 0");
  sql.exec("ALTER TABLE frames ADD COLUMN title_text_color TEXT NOT NULL DEFAULT 'auto'");
  sql.exec("ALTER TABLE frames ADD COLUMN title_align TEXT NOT NULL DEFAULT 'left'");
  sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)", 7);
  sql.exec("INSERT INTO meta (key, value) VALUES ('locked', 1)");
}

/** The statements a version 7 (protocol v12) NoteStore runs to add and delete notes: rollback safety tests run them on schema 8. */
export const V7_NOTE_INSERT = V5_INSERT;
export const V7_NOTE_DELETE = "DELETE FROM notes WHERE id = ?";
