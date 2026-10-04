import { loadSchemaV5 } from "./schemaV5";

/*
 * A room database as slice frames left it (schema version 6, protocol v9): the version 5 notes
 * plus a frames table with no title style columns. Statements are exactly what that NoteStore
 * ran. Generic titles.
 */

export const V6_FRAMES = [
  { id: "v6frame000000001", x: 0, y: 0, w: 640, h: 400, title: "Start", color: "neutral", rev: 1 },
  { id: "v6frame000000002", x: 700, y: 0, w: 800, h: 600, title: "Stop", color: "pink", rev: 3 },
  { id: "v6frame000000003", x: 0, y: 700, w: 240, h: 160, title: "", color: "blue", rev: 2 },
] as const;

const V6_FRAME_COLUMNS = "id, x, y, w, h, title, color, rev, author_id";

/** Replaces whatever the room has with a version 6 database holding the version 5 notes and V6_FRAMES. */
export function loadSchemaV6(sql: SqlStorage): void {
  loadSchemaV5(sql);
  sql.exec(
    `CREATE TABLE IF NOT EXISTS frames (
          id TEXT PRIMARY KEY,
          x INTEGER NOT NULL DEFAULT 0,
          y INTEGER NOT NULL DEFAULT 0,
          w INTEGER NOT NULL DEFAULT 640,
          h INTEGER NOT NULL DEFAULT 400,
          title TEXT NOT NULL DEFAULT '',
          color TEXT NOT NULL DEFAULT 'neutral',
          rev INTEGER NOT NULL DEFAULT 1,
          author_id TEXT NOT NULL DEFAULT ''
        )`,
  );
  sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)", 6);
  for (const f of V6_FRAMES) sql.exec(V6_FRAME_INSERT, f.id, f.x, f.y, f.w, f.h, f.title, f.color, f.rev, "AAAAAAAAAAAAAAAA");
}

/** The statements a version 6 (protocol v9) NoteStore runs to save frames: rollback safety tests run them on schema 7. */
export const V6_FRAME_INSERT = `INSERT INTO frames (${V6_FRAME_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
export const V6_FRAME_UPDATE = "UPDATE frames SET x = ?, y = ?, w = ?, h = ?, title = ?, color = ?, rev = ? WHERE id = ?";
