import { describe, expect, it } from "vitest";
import { SERVER_MESSAGES, serverMessageSchema, type Note, type ServerMessage } from "@stickyard/shared";
import { scrubFor } from "../src/sealed";

/*
 * The relay's last line of defence for silent brainstorm (protocol v17): every outbound message
 * goes through scrubFor with the recipient's view, which drops what that recipient may not see.
 * One sample per note-carrying server message type, each naming a hidden and a visible note.
 */

const HIDDEN = "hiddenNote000001";
const SHOWN = "shownNote0000001";
const FRAME = "frameAAAAAAAAAAA";
const AUTHOR = "AAAAAAAAAAAAAAAA";
const visible = (id: string) => id !== HIDDEN;

const note = (id: string): Note => ({
  id,
  x: 10,
  y: 10,
  w: 160,
  h: 160,
  text: id === HIDDEN ? "canary text" : "shown text",
  color: "yellow",
  fontSize: "m",
  bold: false,
  italic: false,
  textColor: "auto",
  align: "left",
  titleAlign: "left",
  titleFontSize: "m",
  titleBold: false,
  titleItalic: false,
  titleTextColor: "auto",
  z: 0,
  rev: 1,
  authorId: AUTHOR,
});

/** Every note-carrying type, with the hidden note in it (and the visible one where the message can carry two). */
const SAMPLES: Record<string, { both: ServerMessage; hiddenOnly: ServerMessage | null }> = {
  snapshot: { both: { type: "snapshot", notes: [note(HIDDEN), note(SHOWN)] }, hiddenOnly: null },
  noteAdded: { both: { type: "noteAdded", note: note(SHOWN) }, hiddenOnly: { type: "noteAdded", note: note(HIDDEN), clientRef: "r1" } },
  noteUpdated: { both: { type: "noteUpdated", note: note(SHOWN) }, hiddenOnly: { type: "noteUpdated", note: note(HIDDEN) } },
  noteMoved: { both: { type: "noteMoved", id: SHOWN, x: 1, y: 2, rev: 1, final: true }, hiddenOnly: { type: "noteMoved", id: HIDDEN, x: 1, y: 2, rev: 1, final: false } },
  noteResized: {
    both: { type: "noteResized", id: SHOWN, x: 1, y: 2, w: 100, h: 100, rev: 1, final: true },
    hiddenOnly: { type: "noteResized", id: HIDDEN, x: 1, y: 2, w: 100, h: 100, rev: 1, final: true },
  },
  noteDeleted: { both: { type: "noteDeleted", id: SHOWN }, hiddenOnly: { type: "noteDeleted", id: HIDDEN } },
  notesBatchApplied: {
    both: {
      type: "notesBatchApplied",
      results: [
        { type: "noteMoved", id: HIDDEN, x: 1, y: 2, rev: 2, final: true },
        { type: "noteDeleted", id: SHOWN },
      ],
      final: true,
    },
    hiddenOnly: { type: "notesBatchApplied", results: [{ type: "noteDeleted", id: HIDDEN }], final: true },
  },
  notesOrdered: {
    both: { type: "notesOrdered", results: [{ id: HIDDEN, z: 1, rev: 2 }, { id: SHOWN, z: 2, rev: 2 }] },
    hiddenOnly: { type: "notesOrdered", results: [{ id: HIDDEN, z: 1, rev: 2 }] },
  },
  frameMoved: {
    both: { type: "frameMoved", id: FRAME, x: 0, y: 0, rev: 2, final: true, notes: [{ id: HIDDEN, x: 1, y: 1, rev: 2 }, { id: SHOWN, x: 2, y: 2, rev: 2 }] },
    hiddenOnly: null,
  },
  itemsAdded: {
    both: { type: "itemsAdded", notes: [{ note: note(HIDDEN) }, { note: note(SHOWN) }], frames: [], refused: [] },
    hiddenOnly: { type: "itemsAdded", clientRef: "r1", notes: [{ ref: "a", note: note(HIDDEN) }], frames: [], refused: [] },
  },
  voterGranted: { both: { type: "voterGranted", remaining: 3, mine: [{ noteId: HIDDEN, count: 1 }, { noteId: SHOWN, count: 1 }] }, hiddenOnly: null },
  voteConfirmed: { both: { type: "voteConfirmed", noteId: SHOWN, count: 1, remaining: 4 }, hiddenOnly: { type: "voteConfirmed", noteId: HIDDEN, count: 1, remaining: 4 } },
  votesRevealed: { both: { type: "votesRevealed", round: 1, totals: [{ noteId: HIDDEN, count: 3 }, { noteId: SHOWN, count: 2 }] }, hiddenOnly: null },
  silentMine: { both: { type: "silentMine", ids: [HIDDEN, SHOWN] }, hiddenOnly: null },
  notesRevealed: { both: { type: "notesRevealed", notes: [note(HIDDEN), note(SHOWN)], final: true }, hiddenOnly: { type: "notesRevealed", notes: [note(HIDDEN)], final: true } },
};

const carrying = Object.entries(SERVER_MESSAGES)
  .filter(([, v]) => v.carriesNoteContent)
  .map(([k]) => k);

describe("scrubFor", () => {
  it("has a sample for every note-carrying type but error (which only ever echoes the sender's own ids)", () => {
    expect(Object.keys(SAMPLES).sort()).toEqual(carrying.filter((t) => t !== "error").sort());
  });

  for (const [type, { both, hiddenOnly }] of Object.entries(SAMPLES)) {
    it(`${type}: drops the hidden note, keeps the visible one, and the result still validates`, () => {
      const out = scrubFor(both, visible);
      const raw = JSON.stringify(out);
      expect(raw).not.toContain(HIDDEN);
      expect(raw).not.toContain("canary");
      if (JSON.stringify(both).includes(SHOWN)) expect(raw).toContain(SHOWN);
      if (out) expect(serverMessageSchema.safeParse(out).success).toBe(true);
      if (hiddenOnly) expect(scrubFor(hiddenOnly, visible)).toBeNull();
      // Everything visible: unchanged.
      expect(scrubFor(both, () => true)).toEqual(both);
    });
  }

  it("frameMoved without visible carried notes keeps the frame and drops the field", () => {
    const m: ServerMessage = { type: "frameMoved", id: FRAME, x: 0, y: 0, rev: 2, final: true, notes: [{ id: HIDDEN, x: 1, y: 1, rev: 2 }] };
    expect(scrubFor(m, visible)).toEqual({ type: "frameMoved", id: FRAME, x: 0, y: 0, rev: 2, final: true });
  });

  it("itemsAdded keeps frames and shapes when its notes are hidden", () => {
    const frame = { id: FRAME, x: 0, y: 0, w: 640, h: 400, title: "", color: "neutral" as const, titleFontSize: "m" as const, titleBold: true, titleItalic: false, titleTextColor: "auto" as const, titleAlign: "left" as const, rev: 1, authorId: AUTHOR };
    const m: ServerMessage = { type: "itemsAdded", notes: [{ note: note(HIDDEN) }], frames: [{ frame }], refused: [] };
    expect(scrubFor(m, visible)).toEqual({ type: "itemsAdded", notes: [], frames: [{ frame }], refused: [] });
  });

  it("errors are passed through (they echo only what the sender sent, as for an unknown id)", () => {
    const m: ServerMessage = { type: "error", code: "board_locked", message: "No.", noteId: HIDDEN };
    expect(scrubFor(m, visible)).toEqual(m);
  });

  it("messages that carry no note content are never changed", () => {
    const m: ServerMessage = { type: "silentChanged", active: true, count: 3 };
    expect(scrubFor(m, () => false)).toBe(m);
    const echo: ServerMessage = { type: "echo", from: AUTHOR, text: "hi" };
    expect(scrubFor(echo, () => false)).toBe(echo);
  });
});
