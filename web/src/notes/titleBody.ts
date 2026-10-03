/*
 * A note has one text value (protocol v3). The editors show its first line as the Title and
 * the rest as the Body; joining them back puts a line break between them, so there's no
 * schema change. (A real title field would be a protocol change: see PHASE_PLAN.md.)
 */

export function splitTitleBody(text: string): { title: string; body: string } {
  const at = text.indexOf("\n");
  return at === -1 ? { title: text, body: "" } : { title: text.slice(0, at), body: text.slice(at + 1) };
}

export function joinTitleBody(title: string, body: string): string {
  return body === "" ? title : `${title}\n${body}`;
}
