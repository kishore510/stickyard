import { V5_NOTES } from "./schemaV5";
import { V11_FRAME_INSERT, V11_NOTE_DELETE, V11_NOTE_INSERT, V11_NOTE_UPDATE, V11_SHAPE_DELETE, V11_SHAPE_ID, loadSchemaV11 } from "./schemaV11";

/*
 * A room database as arrows left it (schema version 12, protocol v21, v0.35.0 and v0.36.0): the
 * version 11 notes (one sealed), frames, votes, shapes and reactions, plus a connectors table with
 * two connectors (one bound to a note and the shape, one free). Statements are exactly what that
 * NoteStore ran. Generic text.
 */

/** The connectors the fixture holds, by id. */
export const V12_CONNECTOR_IDS = ["v12conn000000001", "v12conn000000002"] as const;

/** Replaces whatever the room has with a version 12 database (the version 11 contents, plus connectors). */
export function loadSchemaV12(sql: SqlStorage): void {
  loadSchemaV11(sql);
  sql.exec(`CREATE TABLE IF NOT EXISTS connectors (
          id TEXT PRIMARY KEY,
          start_item TEXT DEFAULT NULL,
          start_anchor TEXT DEFAULT NULL,
          start_x INTEGER DEFAULT NULL,
          start_y INTEGER DEFAULT NULL,
          end_item TEXT DEFAULT NULL,
          end_anchor TEXT DEFAULT NULL,
          end_x INTEGER DEFAULT NULL,
          end_y INTEGER DEFAULT NULL,
          route TEXT NOT NULL DEFAULT 'straight',
          dash TEXT NOT NULL DEFAULT 'solid',
          width TEXT NOT NULL DEFAULT 'medium',
          ink TEXT NOT NULL DEFAULT 'neutral',
          start_head TEXT NOT NULL DEFAULT 'none',
          end_head TEXT NOT NULL DEFAULT 'arrow',
          rev INTEGER NOT NULL DEFAULT 1,
          author_id TEXT NOT NULL DEFAULT ''
        )`);
  sql.exec(V12_CONNECTOR_INSERT, V12_CONNECTOR_IDS[0], V5_NOTES[0].id, "auto", null, null, V11_SHAPE_ID, "top", null, null, "elbow", "dashed", "thick", "blue", "none", "arrow", 2, "authorAAAAAAAAAA");
  sql.exec(V12_CONNECTOR_INSERT, V12_CONNECTOR_IDS[1], null, null, 10, 20, null, null, 300, 400, "straight", "solid", "medium", "neutral", "none", "arrow", 1, "authorAAAAAAAAAA");
  sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)", 12);
}

/*
 * The statements a version 12 (v0.36.0) NoteStore runs: rollback safety tests run them on schema
 * 13. A note delete is its three statements (the note, its votes, its reactions), plus one connector
 * update per detached end; a shape delete is one statement. It knows nothing of groups, so it never
 * takes a deleted item out of one.
 */
export const V12_CONNECTOR_INSERT = `INSERT INTO connectors (id, start_item, start_anchor, start_x, start_y, end_item, end_anchor, end_x, end_y, route, dash, width, ink, start_head, end_head, rev, author_id) VALUES (${Array.from({ length: 17 }, () => "?").join(", ")})`;
export const V12_NOTE_INSERT = V11_NOTE_INSERT;
export const V12_NOTE_UPDATE = V11_NOTE_UPDATE;
export const V12_NOTE_DELETE = V11_NOTE_DELETE;
export const V12_SHAPE_DELETE = V11_SHAPE_DELETE;
export const V12_FRAME_INSERT = V11_FRAME_INSERT;
export { V11_SHAPE_ID as V12_SHAPE_ID };
