/*
 * A room database as slice 2 (schema version 1, protocol v3) left it: no note sizes or styles.
 * Statements are exactly what that NoteStore ran, plus rows. Fixture text is generic.
 */

export const V1_NOTES = [
  { id: "v1note0000000001", x: 0, y: 0, text: "Idea one", color: "yellow", rev: 1, author_id: "AAAAAAAAAAAAAAAA" },
  { id: "v1note0000000002", x: 3040, y: 1840, text: "Needs follow-up", color: "pink", rev: 7, author_id: "BBBBBBBBBBBBBBBB" },
  { id: "v1note0000000003", x: 1200, y: 640, text: "", color: "purple", rev: 2, author_id: "AAAAAAAAAAAAAAAA" },
] as const;

/** Replaces whatever the room has with a version 1 database holding V1_NOTES. */
export function loadSchemaV1(sql: SqlStorage): void {
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
  sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)", 1);
  for (const n of V1_NOTES) {
    sql.exec(
      "INSERT INTO notes (id, x, y, text, color, rev, author_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
      n.id,
      n.x,
      n.y,
      n.text,
      n.color,
      n.rev,
      n.author_id,
    );
  }
}
