import { V5_COLUMNS } from "./schemaV5";
import { V9_FRAME_INSERT, V9_NOTE_DELETE, V9_NOTE_UPDATE, loadSchemaV9 } from "./schemaV9";

/*
 * A room database as silent brainstorm left it (schema version 10, protocols v17 to v19, up to
 * v0.32.0): the version 9 notes, frames, votes and shapes, with the notes' sealed and writer
 * columns, plus one sealed note. Statements are exactly what that NoteStore ran. Generic text.
 */

/** The sealed note the fixture adds (its writer is a made-up 43-character id). */
export const V10_SEALED = { id: "v10sealed0000001", writer: "w".repeat(43) } as const;

/** Replaces whatever the room has with a version 10 database (the version 9 contents, sealed columns, one sealed note). */
export function loadSchemaV10(sql: SqlStorage): void {
  loadSchemaV9(sql);
  // Schema 10 has no reactions table (schema 11).
  sql.exec("DROP TABLE IF EXISTS reactions");
  // ...nor a connectors table (schema 12).
  sql.exec("DROP TABLE IF EXISTS connectors");
  // ...nor the groups tables (schema 13).
  sql.exec("DROP TABLE IF EXISTS groups");
  sql.exec("DROP TABLE IF EXISTS group_members");
  sql.exec("ALTER TABLE notes ADD COLUMN sealed INTEGER NOT NULL DEFAULT 0");
  sql.exec("ALTER TABLE notes ADD COLUMN writer TEXT DEFAULT NULL");
  sql.exec(V10_NOTE_INSERT, V10_SEALED.id, 40, 40, 160, 160, "Hidden idea", "pink", "m", 0, 0, "auto", "left", "left", "m", 0, 0, "auto", 12, 1, "authorAAAAAAAAAA", 1, V10_SEALED.writer);
  sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('silent_active', ?)", 1);
  sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('silent_round', ?)", 1);
  sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)", 10);
}

/*
 * The statements a version 10 (v0.32.0) NoteStore runs to save notes and frames: rollback safety
 * tests run them on schema 11. A note delete is its two statements (the note, then its votes);
 * it knows nothing of reactions.
 */
export const V10_NOTE_INSERT = `INSERT INTO notes (${V5_COLUMNS}, sealed, writer) VALUES (${Array.from({ length: 22 }, () => "?").join(", ")})`;
export const V10_NOTE_UPDATE = V9_NOTE_UPDATE;
export const V10_NOTE_DELETE = V9_NOTE_DELETE;
export const V10_FRAME_INSERT = V9_FRAME_INSERT;
