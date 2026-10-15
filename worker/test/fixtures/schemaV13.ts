import { V5_NOTES } from "./schemaV5";
import { V9_FRAME_UPDATE, V9_SHAPE_INSERT } from "./schemaV9";
import { V12_FRAME_INSERT, V12_NOTE_INSERT, V12_NOTE_UPDATE, V12_SHAPE_ID, loadSchemaV12 } from "./schemaV12";

/*
 * A room database as groups left it (schema version 13, protocol v22, v0.37.0 to v0.40.0): the
 * version 12 notes (one sealed), frames, votes, shapes, reactions and connectors, plus the groups
 * tables with one group (a note and the shape). Statements are exactly what that NoteStore ran.
 * Generic text.
 */

export const V13_GROUP_ID = "v13group00000001";

/** Replaces whatever the room has with a version 13 database (the version 12 contents, plus one group). */
export function loadSchemaV13(sql: SqlStorage): void {
  loadSchemaV12(sql);
  sql.exec(`CREATE TABLE IF NOT EXISTS groups (
          id TEXT PRIMARY KEY,
          label TEXT NOT NULL DEFAULT '',
          color TEXT NOT NULL DEFAULT 'neutral',
          rev INTEGER NOT NULL DEFAULT 1
        )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS group_members (
          item_id TEXT NOT NULL PRIMARY KEY,
          group_id TEXT NOT NULL DEFAULT ''
        ) WITHOUT ROWID`);
  sql.exec("INSERT INTO groups (id, label, color, rev) VALUES (?, ?, ?, ?)", V13_GROUP_ID, "Cluster", "blue", 1);
  for (const item of [V5_NOTES[0].id, V12_SHAPE_ID]) sql.exec("INSERT INTO group_members (item_id, group_id) VALUES (?, ?)", item, V13_GROUP_ID);
  sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)", 13);
}

/*
 * The statements a version 13 (v0.40.0) NoteStore runs to save notes, frames and shapes (it knows
 * nothing of `placed`): rollback safety tests run them on schema 14.
 */
export const V13_NOTE_INSERT = V12_NOTE_INSERT;
export const V13_NOTE_UPDATE = V12_NOTE_UPDATE;
export const V13_FRAME_INSERT = V12_FRAME_INSERT;
export const V13_FRAME_UPDATE = V9_FRAME_UPDATE;
export const V13_SHAPE_INSERT = V9_SHAPE_INSERT;
export const V13_SHAPE_UPDATE = `UPDATE shapes SET x = ?, y = ?, w = ?, h = ?, text = ?, fill = ?, stroke = ?, stroke_width = ?, stroke_style = ?, font_size = ?,
       bold = ?, italic = ?, underline = ?, text_color = ?, align = ?, valign = ?, z = ?, rev = ?
       WHERE id = ?`;
