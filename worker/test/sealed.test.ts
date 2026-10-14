import { describe, expect, it } from "vitest";
import { SERVER_MESSAGES, serverMessageSchema, type Connector, type Group, type Note, type ServerMessage } from "@stickyard/shared";
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

/** A connector from a free point to `item` (by its end, or its start). */
const connector = (id: string, item: string, side: "start" | "end" = "start"): Connector => {
  const free = { x: 5, y: 5 };
  const bound = { item, anchor: "auto" as const };
  return { id, start: side === "start" ? bound : free, end: side === "end" ? bound : free, route: "straight", dash: "solid", width: "medium", ink: "neutral", startHead: "none", endHead: "arrow", rev: 1, authorId: AUTHOR };
};

/** A group of `members` (protocol v22). */
const group = (id: string, members: string[]): Group => ({ id, label: "Label", color: "neutral", members: [...members].sort(), rev: 1 });
const SHAPE_A = "shapeAAAAAAAAAAA";
const SHAPE_B = "shapeBBBBBBBBBBB";

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
  voterGranted: {
    both: { type: "voterGranted", remaining: 3, mine: [{ noteId: HIDDEN, count: 1 }, { noteId: SHOWN, count: 1 }], reactions: [{ noteId: HIDDEN, key: "heart" }, { noteId: SHOWN, key: "plus" }] },
    hiddenOnly: null,
  },
  voteConfirmed: { both: { type: "voteConfirmed", noteId: SHOWN, count: 1, remaining: 4 }, hiddenOnly: { type: "voteConfirmed", noteId: HIDDEN, count: 1, remaining: 4 } },
  votesRevealed: { both: { type: "votesRevealed", round: 1, totals: [{ noteId: HIDDEN, count: 3 }, { noteId: SHOWN, count: 2 }] }, hiddenOnly: null },
  silentMine: { both: { type: "silentMine", ids: [HIDDEN, SHOWN] }, hiddenOnly: null },
  // Reactions (protocol v20).
  reactionCount: { both: { type: "reactionCount", noteId: SHOWN, key: "heart", count: 2 }, hiddenOnly: { type: "reactionCount", noteId: HIDDEN, key: "heart", count: 0 } },
  reactionMine: { both: { type: "reactionMine", noteId: SHOWN, key: "laugh", on: true }, hiddenOnly: { type: "reactionMine", noteId: HIDDEN, key: "laugh", on: false } },
  reactionsSnapshot: {
    both: { type: "reactionsSnapshot", counts: [{ noteId: HIDDEN, key: "heart", count: 1 }, { noteId: SHOWN, key: "thinking", count: 3 }] },
    hiddenOnly: null,
  },
  notesRevealed: { both: { type: "notesRevealed", notes: [note(HIDDEN), note(SHOWN)], final: true }, hiddenOnly: { type: "notesRevealed", notes: [note(HIDDEN)], final: true } },
  // Connectors (protocol v21): the relay never binds one to a sealed note; a connector naming one is dropped whole.
  connectorsSnapshot: { both: { type: "connectorsSnapshot", connectors: [connector("connHidden000001", HIDDEN), connector("connShown0000001", SHOWN)] }, hiddenOnly: null },
  connectorAdded: { both: { type: "connectorAdded", connector: connector("connShown0000001", SHOWN) }, hiddenOnly: { type: "connectorAdded", connector: connector("connHidden000001", HIDDEN), clientRef: "r1" } },
  connectorUpdated: { both: { type: "connectorUpdated", connector: connector("connShown0000001", SHOWN) }, hiddenOnly: { type: "connectorUpdated", connector: connector("connHidden000001", HIDDEN, "end") } },
  // Groups (protocol v22): the relay never puts a sealed note in one; a hidden member is left out,
  // and a group left with fewer than 2 members is left out whole.
  groupsSnapshot: {
    both: { type: "groupsSnapshot", groups: [group("groupHidden00001", [HIDDEN, SHAPE_A]), group("groupShown000001", [HIDDEN, SHOWN, SHAPE_B])] },
    hiddenOnly: null,
  },
  groupCreated: { both: { type: "groupCreated", group: group("groupShown000001", [HIDDEN, SHOWN, SHAPE_A]) }, hiddenOnly: { type: "groupCreated", group: group("groupHidden00001", [HIDDEN, SHAPE_A]), clientRef: "r1" } },
  groupUpdated: { both: { type: "groupUpdated", group: group("groupShown000001", [SHOWN, SHAPE_A, HIDDEN]) }, hiddenOnly: { type: "groupUpdated", group: group("groupHidden00001", [HIDDEN, SHAPE_B]) } },
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

  it("voterGranted drops its reactions field when none of them is visible, and keeps the votes", () => {
    const m: ServerMessage = { type: "voterGranted", remaining: 4, mine: [{ noteId: SHOWN, count: 1 }], reactions: [{ noteId: HIDDEN, key: "heart" }] };
    expect(scrubFor(m, visible)).toEqual({ type: "voterGranted", remaining: 4, mine: [{ noteId: SHOWN, count: 1 }] });
  });

  it("a connector bound to a frame or shape id (never a note) is always kept", () => {
    const m: ServerMessage = { type: "connectorUpdated", connector: connector("connShape0000001", "shapeAAAAAAAAAAA") };
    expect(scrubFor(m, (id) => id.startsWith("shape") || id === SHOWN)).toEqual(m);
  });

  it("groups: a hidden member is left out and the group keeps going at 2 or more; the snapshot keeps every visible group", () => {
    const m: ServerMessage = { type: "groupsSnapshot", groups: [group("groupHidden00001", [HIDDEN, SHAPE_A]), group("groupShown000001", [HIDDEN, SHOWN, SHAPE_B])] };
    expect(scrubFor(m, visible)).toEqual({ type: "groupsSnapshot", groups: [group("groupShown000001", [SHOWN, SHAPE_B])] });
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
