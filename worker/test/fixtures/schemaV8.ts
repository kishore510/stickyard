import { V5_INSERT, V5_UPDATE } from "./schemaV5";
import { loadSchemaV7 } from "./schemaV7";

/*
 * A room database as dot voting left it (schema version 8, protocols v13 and v14, up to v0.20.0):
 * the version 7 notes and frames, a votes table, and no shapes table. Statements are exactly what
 * that NoteStore ran. Generic text.
 */

/** Replaces whatever the room has with a version 8 database (the version 7 contents, plus votes). */
export function loadSchemaV8(sql: SqlStorage): void {
  loadSchemaV7(sql);
  sql.exec(
    `CREATE TABLE IF NOT EXISTS votes (
          voter_id TEXT NOT NULL DEFAULT '',
          note_id TEXT NOT NULL DEFAULT '',
          count INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (voter_id, note_id)
        )`,
  );
  sql.exec("INSERT INTO votes (voter_id, note_id, count) VALUES (?, ?, ?)", "voter-one", "v5note0000000002", 2);
  sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)", 8);
}

const V8_FRAME_COLUMNS = "id, x, y, w, h, title, color, rev, author_id, title_font_size, title_bold, title_italic, title_text_color, title_align";

/*
 * The statements a version 8 (v0.20.0) NoteStore runs to save notes and frames: rollback safety
 * tests run them on schema 9. A note delete is its two statements (the note, then its votes).
 */
export const V8_NOTE_INSERT = V5_INSERT;
export const V8_NOTE_UPDATE = V5_UPDATE;
export const V8_NOTE_DELETE = ["DELETE FROM notes WHERE id = ?", "DELETE FROM votes WHERE note_id = ?"] as const;
export const V8_FRAME_INSERT = `INSERT INTO frames (${V8_FRAME_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
export const V8_FRAME_UPDATE = `UPDATE frames SET x = ?, y = ?, w = ?, h = ?, title = ?, color = ?, rev = ?,
       title_font_size = ?, title_bold = ?, title_italic = ?, title_text_color = ?, title_align = ?
       WHERE id = ?`;
export const V8_FRAME_DELETE = "DELETE FROM frames WHERE id = ?";
