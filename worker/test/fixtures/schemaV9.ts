import { V8_FRAME_DELETE, V8_FRAME_INSERT, V8_FRAME_UPDATE, V8_NOTE_DELETE, V8_NOTE_INSERT, V8_NOTE_UPDATE, loadSchemaV8 } from "./schemaV8";

/*
 * A room database as text and shapes left it (schema version 9, protocols v15 and v16, up to
 * v0.24.0): the version 8 notes, frames and votes, plus a shapes table with one shape. Statements
 * are exactly what that NoteStore ran. Generic text.
 */

/** Replaces whatever the room has with a version 9 database (the version 8 contents, plus shapes). */
export function loadSchemaV9(sql: SqlStorage): void {
  loadSchemaV8(sql);
  sql.exec(
    `CREATE TABLE IF NOT EXISTS shapes (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL DEFAULT 'rect',
          x INTEGER NOT NULL DEFAULT 0,
          y INTEGER NOT NULL DEFAULT 0,
          w INTEGER NOT NULL DEFAULT 200,
          h INTEGER NOT NULL DEFAULT 120,
          text TEXT NOT NULL DEFAULT '',
          fill TEXT NOT NULL DEFAULT 'neutral',
          stroke TEXT NOT NULL DEFAULT 'neutral',
          stroke_width TEXT NOT NULL DEFAULT 'thin',
          stroke_style TEXT NOT NULL DEFAULT 'solid',
          font_size TEXT NOT NULL DEFAULT 'm',
          bold INTEGER NOT NULL DEFAULT 0,
          italic INTEGER NOT NULL DEFAULT 0,
          underline INTEGER NOT NULL DEFAULT 0,
          text_color TEXT NOT NULL DEFAULT 'auto',
          align TEXT NOT NULL DEFAULT 'center',
          valign TEXT NOT NULL DEFAULT 'middle',
          z INTEGER NOT NULL DEFAULT 0,
          rev INTEGER NOT NULL DEFAULT 1,
          author_id TEXT NOT NULL DEFAULT ''
        )`,
  );
  sql.exec(V9_SHAPE_INSERT, ...V9_SHAPE);
  sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)", 9);
}

const V9_SHAPE_COLUMNS = "id, kind, x, y, w, h, text, fill, stroke, stroke_width, stroke_style, font_size, bold, italic, underline, text_color, align, valign, z, rev, author_id";
export const V9_SHAPE_INSERT = `INSERT INTO shapes (${V9_SHAPE_COLUMNS}) VALUES (${Array.from({ length: 21 }, () => "?").join(", ")})`;
/** The shape the fixture holds. */
export const V9_SHAPE = ["v9shape000000001", "oval", 300, 300, 200, 120, "Parking lot", "blue", "neutral", "thin", "solid", "m", 0, 0, 0, "auto", "center", "middle", 7, 1, "authorAAAAAAAAAA"] as const;

/*
 * The statements a version 9 (v0.24.0) NoteStore runs to save notes and frames (unchanged since
 * version 8): rollback safety tests run them on schema 10.
 */
export const V9_NOTE_INSERT = V8_NOTE_INSERT;
export const V9_NOTE_UPDATE = V8_NOTE_UPDATE;
export const V9_NOTE_DELETE = V8_NOTE_DELETE;
export const V9_FRAME_INSERT = V8_FRAME_INSERT;
export const V9_FRAME_UPDATE = V8_FRAME_UPDATE;
export const V9_FRAME_DELETE = V8_FRAME_DELETE;
