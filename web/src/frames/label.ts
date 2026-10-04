/** Deleting a frame asks first when it has a title or notes inside. Its notes are never deleted. */
export function confirmFrameDelete(title: string, notesInside: number): boolean {
  if (title === "" && notesInside === 0) return true;
  const inside = notesInside > 0 ? ` Its ${notesInside === 1 ? "note stays" : `${notesInside} notes stay`} on the board.` : "";
  return window.confirm(`Delete this frame${title ? ` (“${title}”)` : ""}?${inside}`);
}
