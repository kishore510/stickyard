import { describe, expect, it } from "vitest";
import {
  BOARD_WRITES,
  FRAME_COLORS,
  GROUP_COLORS,
  GROUPS_SNAPSHOT_MAX_BYTES,
  HOST_ONLY,
  MAX_GROUP_LABEL,
  MAX_GROUP_MEMBERS,
  MAX_GROUPS_PER_ROOM,
  MAX_MESSAGE_BYTES,
  MAX_NOTES_PER_ROOM,
  MAX_SERVER_MESSAGE_BYTES,
  MAX_SHAPES_PER_ROOM,
  MIN_GROUP_MEMBERS,
  PROTOCOL_VERSION,
  SERVER_MESSAGES,
  cleanGroupLabel,
  clientMessageSchema,
  encodeMessage,
  errorCodeSchema,
  errorMessageSchema,
  serverMessageSchema,
  utf8Length,
} from "../src";

/*
 * Protocol v22 (group boxes, structure part 1 of 3: relay and shared). A group is a set of notes
 * and shapes with a label and a colour key; the box is never stored (pages derive it from the
 * members' boxes). Generic fixtures only; a hostile string stands in wherever text could appear.
 */

const HOSTILE = "<img src=x onerror=alert(1)>";
const ID = "AAAAAAAAAAAAAAAA";
const ids = (n: number, prefix = "m") => Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(15, "0")}`);
const ok = (m: unknown) => clientMessageSchema.safeParse(m).success;
const serverOk = (m: unknown) => serverMessageSchema.safeParse(m).success;
const create = (extra: Record<string, unknown> = {}) => ({ type: "groupCreate", clientRef: "g1", label: HOSTILE, color: "blue", members: ids(2), ...extra });
const group = (extra: Record<string, unknown> = {}) => ({ id: ID, label: HOSTILE, color: "blue", members: ids(2), rev: 1, ...extra });

describe("protocol v22", () => {
  it("is version 22 or later", () => {
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(22);
  });

  it("caps: 30 groups a room, 2 to 100 members, labels up to 40 characters; colours are the frame keys", () => {
    expect(MAX_GROUPS_PER_ROOM).toBe(30);
    expect(MIN_GROUP_MEMBERS).toBe(2);
    expect(MAX_GROUP_MEMBERS).toBe(100);
    expect(MAX_GROUP_LABEL).toBe(40);
    expect(GROUP_COLORS).toEqual(FRAME_COLORS);
    // Every note and shape can be grouped within the caps: 30 groups of up to 100 hold a full board.
    expect(MAX_GROUPS_PER_ROOM * MAX_GROUP_MEMBERS).toBeGreaterThanOrEqual(MAX_NOTES_PER_ROOM + MAX_SHAPES_PER_ROOM);
  });

  it("all four client messages change the board (a lock refuses a guest's) and none is host-only", () => {
    for (const t of ["groupCreate", "groupUpdate", "groupMembers", "groupDelete"] as const) {
      expect(BOARD_WRITES[t]).toBe(true);
      expect(HOST_ONLY).not.toContain(t);
    }
  });

  it("messages that list members can name a note, so they are note-carrying; a delete names only the group", () => {
    expect(SERVER_MESSAGES.groupsSnapshot.carriesNoteContent).toBe(true);
    expect(SERVER_MESSAGES.groupCreated.carriesNoteContent).toBe(true);
    expect(SERVER_MESSAGES.groupUpdated.carriesNoteContent).toBe(true);
    expect(SERVER_MESSAGES.groupDeleted.carriesNoteContent).toBe(false);
  });

  it("new error codes groups_full, group_size and unknown_group; errors may name a group", () => {
    for (const code of ["groups_full", "group_size", "unknown_group", "unknown_item"]) expect(errorCodeSchema.safeParse(code).success).toBe(true);
    expect(errorMessageSchema.safeParse({ type: "error", code: "unknown_group", message: "No.", groupId: ID }).success).toBe(true);
    expect(errorMessageSchema.safeParse({ type: "error", code: "unknown_group", message: "No.", groupId: HOSTILE }).success).toBe(false);
  });
});

describe("labels", () => {
  it("one line: whitespace collapses, controls and invisible characters go, trimmed; may be empty", () => {
    expect(cleanGroupLabel("  Team\n\tideas  ")).toBe("Team ideas");
    expect(cleanGroupLabel("a​b\u0007")).toBe("ab");
    expect(cleanGroupLabel("")).toBe("");
    expect(cleanGroupLabel("   ")).toBe("");
    expect(cleanGroupLabel(HOSTILE)).toBe(HOSTILE);
  });

  it(`at most ${MAX_GROUP_LABEL} characters (code points) after cleaning`, () => {
    expect(cleanGroupLabel("x".repeat(MAX_GROUP_LABEL))).toBe("x".repeat(MAX_GROUP_LABEL));
    expect(cleanGroupLabel("😀".repeat(MAX_GROUP_LABEL))).toBe("😀".repeat(MAX_GROUP_LABEL));
    expect(cleanGroupLabel("x".repeat(MAX_GROUP_LABEL + 1))).toBeNull();
    expect(cleanGroupLabel(` ${"x".repeat(MAX_GROUP_LABEL)}  `)).toBe("x".repeat(MAX_GROUP_LABEL));
  });
});

describe("groupCreate", () => {
  it("label, colour key and members (the server assigns id and rev)", () => {
    expect(ok(create())).toBe(true);
    expect(ok(create({ label: "" }))).toBe(true);
    expect(ok(create({ members: ids(MAX_GROUP_MEMBERS) }))).toBe(true);
    for (const color of GROUP_COLORS) expect(ok(create({ color }))).toBe(true);
  });

  it("refused by the schema: a colour that isn't a key, a label over 40 characters, over 100 members, bad or duplicate ids, missing fields", () => {
    expect(ok(create({ color: "#ff0000" }))).toBe(false);
    expect(ok(create({ color: HOSTILE }))).toBe(false);
    expect(ok(create({ label: "x".repeat(MAX_GROUP_LABEL + 1) }))).toBe(false);
    expect(ok(create({ label: "😀".repeat(MAX_GROUP_LABEL) }))).toBe(true);
    expect(ok(create({ members: ids(MAX_GROUP_MEMBERS + 1) }))).toBe(false);
    expect(ok(create({ members: [ID, ID] }))).toBe(false);
    expect(ok(create({ members: [ID, HOSTILE] }))).toBe(false);
    expect(ok(create({ members: "AAAA" }))).toBe(false);
    const { members: _m, ...noMembers } = create();
    expect(ok(noMembers)).toBe(false);
    const { clientRef: _c, ...noRef } = create();
    expect(ok(noRef)).toBe(false);
  });

  it("fewer than 2 members passes the schema: the relay answers group_size", () => {
    expect(ok(create({ members: [] }))).toBe(true);
    expect(ok(create({ members: [ID] }))).toBe(true);
  });

  it("strict: no id, rev, author or box", () => {
    for (const extra of [{ id: ID }, { rev: 1 }, { authorId: ID }, { x: 0, y: 0, w: 10, h: 10 }]) expect(ok(create(extra))).toBe(false);
  });

  it("the largest groupCreate (100 members, a 40-character label of lone surrogates) fits a client message", () => {
    const label = "\uD800".repeat(MAX_GROUP_LABEL);
    const raw = JSON.stringify(create({ clientRef: "r".repeat(32), label, color: "neutral", members: ids(MAX_GROUP_MEMBERS) }));
    expect(ok(JSON.parse(raw))).toBe(true);
    expect(utf8Length(raw)).toBeLessThan(MAX_MESSAGE_BYTES);
  });
});

describe("groupUpdate", () => {
  it("a label and/or a colour; at least one; strict", () => {
    expect(ok({ type: "groupUpdate", id: ID, label: "" })).toBe(true);
    expect(ok({ type: "groupUpdate", id: ID, color: "pink" })).toBe(true);
    expect(ok({ type: "groupUpdate", id: ID, label: HOSTILE, color: "neutral" })).toBe(true);
    expect(ok({ type: "groupUpdate", id: ID })).toBe(false);
    expect(ok({ type: "groupUpdate", id: ID, color: "red" })).toBe(false);
    expect(ok({ type: "groupUpdate", id: ID, label: "x".repeat(MAX_GROUP_LABEL + 1) })).toBe(false);
    expect(ok({ type: "groupUpdate", id: ID, label: "x", rev: 2 })).toBe(false);
    expect(ok({ type: "groupUpdate", id: ID, label: "x", members: ids(2) })).toBe(false);
    expect(ok({ type: "groupUpdate", id: HOSTILE, label: "x" })).toBe(false);
  });
});

describe("groupMembers", () => {
  it("ids to add and to remove, up to 100 each; at least one id; no id twice", () => {
    expect(ok({ type: "groupMembers", id: ID, add: ids(1), remove: [] })).toBe(true);
    expect(ok({ type: "groupMembers", id: ID, add: [], remove: ids(1) })).toBe(true);
    expect(ok({ type: "groupMembers", id: ID, add: ids(MAX_GROUP_MEMBERS, "a"), remove: ids(MAX_GROUP_MEMBERS, "r") })).toBe(true);
    expect(ok({ type: "groupMembers", id: ID, add: [], remove: [] })).toBe(false);
    expect(ok({ type: "groupMembers", id: ID, add: ids(MAX_GROUP_MEMBERS + 1), remove: [] })).toBe(false);
    expect(ok({ type: "groupMembers", id: ID, add: [], remove: ids(MAX_GROUP_MEMBERS + 1) })).toBe(false);
    expect(ok({ type: "groupMembers", id: ID, add: [ID, ID], remove: [] })).toBe(false);
    expect(ok({ type: "groupMembers", id: ID, add: [ID], remove: [ID] })).toBe(false);
    expect(ok({ type: "groupMembers", id: ID, add: [HOSTILE], remove: [] })).toBe(false);
    expect(ok({ type: "groupMembers", id: ID, add: ids(1) })).toBe(false);
    expect(ok({ type: "groupMembers", id: ID, add: ids(1), remove: [], label: "x" })).toBe(false);
  });

  it("the largest groupMembers (100 to add and 100 to remove) fits a client message", () => {
    const raw = JSON.stringify({ type: "groupMembers", id: ID, add: ids(MAX_GROUP_MEMBERS, "a"), remove: ids(MAX_GROUP_MEMBERS, "r") });
    expect(utf8Length(raw)).toBeLessThan(MAX_MESSAGE_BYTES);
  });
});

describe("groupDelete", () => {
  it("an id, strict", () => {
    expect(ok({ type: "groupDelete", id: ID })).toBe(true);
    expect(ok({ type: "groupDelete", id: HOSTILE })).toBe(false);
    expect(ok({ type: "groupDelete", id: ID, members: [] })).toBe(false);
    expect(ok({ type: "groupDelete" })).toBe(false);
  });
});

describe("server messages", () => {
  it("a group as sent: a clean label, a colour key, 2 to 100 distinct member ids, rev", () => {
    expect(serverOk({ type: "groupCreated", group: group(), clientRef: "g1" })).toBe(true);
    expect(serverOk({ type: "groupUpdated", group: group({ rev: 7, members: ids(MAX_GROUP_MEMBERS) }) })).toBe(true);
    expect(serverOk({ type: "groupUpdated", group: group({ members: ids(1) }) })).toBe(false);
    expect(serverOk({ type: "groupUpdated", group: group({ members: ids(MAX_GROUP_MEMBERS + 1) }) })).toBe(false);
    expect(serverOk({ type: "groupUpdated", group: group({ members: [ID, ID] }) })).toBe(false);
    expect(serverOk({ type: "groupUpdated", group: group({ label: " untrimmed " }) })).toBe(false);
    expect(serverOk({ type: "groupUpdated", group: group({ label: "a\nb" }) })).toBe(false);
    expect(serverOk({ type: "groupUpdated", group: group({ color: "#000" }) })).toBe(false);
    expect(serverOk({ type: "groupUpdated", group: group({ rev: 0 }) })).toBe(false);
    expect(serverOk({ type: "groupDeleted", id: ID })).toBe(true);
    expect(serverOk({ type: "groupDeleted", id: HOSTILE })).toBe(false);
  });

  it(`groupsSnapshot: up to ${MAX_GROUPS_PER_ROOM} groups, strict`, () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => group({ id: `g${String(i).padStart(15, "0")}`, members: [`a${String(i).padStart(15, "0")}`, `b${String(i).padStart(15, "0")}`] }));
    expect(serverOk({ type: "groupsSnapshot", groups: [] })).toBe(true);
    expect(serverOk({ type: "groupsSnapshot", groups: many(MAX_GROUPS_PER_ROOM) })).toBe(true);
    expect(serverOk({ type: "groupsSnapshot", groups: many(MAX_GROUPS_PER_ROOM + 1) })).toBe(false);
    expect(serverOk({ type: "groupsSnapshot", groups: [], extra: 1 })).toBe(false);
  });

  it(`the worst-case groupsSnapshot (every note and shape grouped, longest labels) stays under 90% of its ${GROUPS_SNAPSHOT_MAX_BYTES / 1024} KiB test cap`, () => {
    // 30 groups holding all 250 notes and shapes, 40 lone surrogates in every label (6 bytes each
    // escaped), the longest colour key, rev at its largest.
    const items = ids(MAX_NOTES_PER_ROOM + MAX_SHAPES_PER_ROOM, "i");
    const longest = GROUP_COLORS.reduce((a, b) => (b.length > a.length ? b : a));
    const groups = Array.from({ length: MAX_GROUPS_PER_ROOM }, (_, g) => ({
      id: `g${String(g).padStart(15, "0")}`,
      label: "\uD800".repeat(MAX_GROUP_LABEL),
      color: longest,
      members: items.filter((_, i) => i % MAX_GROUPS_PER_ROOM === g),
      rev: Number.MAX_SAFE_INTEGER,
    }));
    const message = serverMessageSchema.parse({ type: "groupsSnapshot", groups });
    const bytes = utf8Length(encodeMessage(message));
    expect(groups.reduce((n, g) => n + g.members.length, 0)).toBe(MAX_NOTES_PER_ROOM + MAX_SHAPES_PER_ROOM);
    expect(bytes).toBeLessThan(GROUPS_SNAPSHOT_MAX_BYTES * 0.9);
    expect(bytes).toBeLessThan(MAX_SERVER_MESSAGE_BYTES / 16);
  });

  it("the largest groupUpdated (100 members, the longest label) is a few KB", () => {
    const message = serverMessageSchema.parse({ type: "groupUpdated", group: group({ label: "\uD800".repeat(MAX_GROUP_LABEL), color: "neutral", members: ids(MAX_GROUP_MEMBERS), rev: Number.MAX_SAFE_INTEGER }) });
    expect(utf8Length(encodeMessage(message))).toBeLessThan(2.5 * 1024);
  });
});
