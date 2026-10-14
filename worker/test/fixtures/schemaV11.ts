import { V5_NOTES } from "./schemaV5";
import { V9_SHAPE } from "./schemaV9";
import { V10_FRAME_INSERT, V10_NOTE_DELETE, V10_NOTE_INSERT, V10_NOTE_UPDATE, loadSchemaV10 } from "./schemaV10";

/*
 * A room database as reactions left it (schema version 11, protocol v20, v0.33.0 and v0.34.0):
 * the version 10 notes (one sealed), frames, votes and shapes, plus a reactions table with two
 * reactions. Statements are exactly what that NoteStore ran. Generic text.
 */

/** The reactions the fixture holds: [reactor id, note id, key]. */
export const V11_REACTIONS = [
  ["r".repeat(43), V5_NOTES[0].id, "heart"],
  ["s".repeat(43), V5_NOTES[0].id, "heart"],
] as const;

/** Replaces whatever the room has with a version 11 database (the version 10 contents, plus reactions). */
export function loadSchemaV11(sql: SqlStorage): void {
  loadSchemaV10(sql);
  sql.exec(`CREATE TABLE IF NOT EXISTS reactions (
          reactor_id TEXT NOT NULL DEFAULT '',
          note_id TEXT NOT NULL DEFAULT '',
          reaction_key TEXT NOT NULL DEFAULT '',
          PRIMARY KEY (reactor_id, note_id, reaction_key)
        )`);
  for (const row of V11_REACTIONS) sql.exec("INSERT INTO reactions (reactor_id, note_id, reaction_key) VALUES (?, ?, ?)", ...row);
  sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)", 11);
}

/*
 * The statements a version 11 (v0.34.0) NoteStore runs: rollback safety tests run them on schema
 * 12. A note delete is its three statements (the note, its votes, its reactions); a shape delete is
 * one. It knows nothing of connectors, so it never detaches one.
 */
export const V11_NOTE_INSERT = V10_NOTE_INSERT;
export const V11_NOTE_UPDATE = V10_NOTE_UPDATE;
export const V11_NOTE_DELETE = [...V10_NOTE_DELETE, "DELETE FROM reactions WHERE note_id = ?"] as const;
export const V11_SHAPE_DELETE = "DELETE FROM shapes WHERE id = ?";
export const V11_FRAME_INSERT = V10_FRAME_INSERT;
/** The shape the fixture holds (from version 9). */
export const V11_SHAPE_ID = V9_SHAPE[0];
