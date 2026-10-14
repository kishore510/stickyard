// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_GROUPS_PER_ROOM, type Group } from "@stickyard/shared";
import { GROUP_TEXT } from "../src/groups/rules";
import { LOCK_TEXT } from "../src/facilitation/lock";
import { HISTORY_TEXT } from "../src/history/history";
import { SILENT_TEXT } from "../src/silent/silent";
import { ITEMS_STEP_MS, NOTICES } from "../src/rooms/session";
import { connector, gid, group, nid, note, room, shape, sid } from "./helpers/fakeRelay";

/*
 * Groups part 2 (web only): the session's groups. The fake relay stores and answers like the
 * Worker (v0.37.0): groupCreate/Update/Members/Delete, moves between groups, dissolving below 2
 * (also when a member is deleted), and refusals by code.
 */

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const notes = (n: number) => Array.from({ length: n }, (_, i) => note(i + 1, { x: 100 + 250 * (i % 20), y: 100 + 300 * Math.floor(i / 20) }));
const withGroups = (groups: Group[], ns = notes(4), shapes = [shape(1)]) => room(ns, [], {}, undefined, shapes, [], groups);
const groupIds = (t: ReturnType<typeof room>) => t.view().board.groups.map((g) => g.group.id);
const groupMsgs = (t: ReturnType<typeof room>) => t.relay.received.filter((m) => typeof m.type === "string" && m.type.startsWith("group"));

describe("session state from the relay", () => {
  it("the join's groupsSnapshot fills the board; a reconnect's replaces it", () => {
    const t = withGroups([group(1, [nid(1), nid(2)]), group(2, [nid(3), sid(1)])]);
    expect(groupIds(t)).toEqual([gid(1), gid(2)]);
    t.relay.groups.delete(gid(2));
    t.relay.drop();
    vi.advanceTimersByTime(1300);
    t.relay.open();
    expect(t.view().status).toBe("joined");
    expect(groupIds(t)).toEqual([gid(1)]);
  });

  it("groupCreated, groupUpdated (by rev) and groupDeleted from someone else; unknown ids ignored; membership is exclusive", () => {
    const t = withGroups([group(1, [nid(1), nid(2), nid(3)])]);
    t.relay.groups.set(gid(2), group(2, [nid(3), nid(4)]));
    t.relay.emit({ type: "groupCreated", group: group(2, [nid(3), nid(4)], { rev: 1 }) });
    expect(t.shownGroup(gid(1))?.members).toEqual([nid(1), nid(2)]);
    t.relay.samEditGroup(gid(2), { label: "Themes" });
    expect(t.shownGroup(gid(2))?.label).toBe("Themes");
    t.relay.emit({ type: "groupUpdated", group: group(2, [nid(3), nid(4)], { rev: 1, label: "old" }) });
    expect(t.shownGroup(gid(2))?.label).toBe("Themes");
    const before = t.view().board.groups;
    t.relay.emit({ type: "groupUpdated", group: group(9, [nid(1), nid(2)], { rev: 5 }) });
    t.relay.emit({ type: "groupDeleted", id: gid(9) });
    expect(t.view().board.groups).toEqual(before);
    t.relay.emit({ type: "groupDeleted", id: gid(2) });
    expect(groupIds(t)).toEqual([gid(1)]);
  });
});

describe("optimistic changes and each rollback", () => {
  it("a group shows at once with a local id, then takes the server id; items in another group move into it", () => {
    const t = withGroups([group(1, [nid(1), nid(2), nid(3)])]);
    const local = t.session.createGroup([nid(3), nid(4)], { label: "Ideas" });
    expect(local).toMatch(/^local:/);
    expect(groupMsgs(t)).toEqual([{ type: "groupCreate", clientRef: expect.any(String), label: "Ideas", color: "neutral", members: [nid(3), nid(4)] }]);
    expect(groupIds(t)).toHaveLength(2);
    expect(groupIds(t).some((id) => id.startsWith("local:"))).toBe(false);
    expect(t.shownGroup(gid(1))?.members).toEqual([nid(1), nid(2)]);
  });

  it.each([
    ["groups_full", GROUP_TEXT.full],
    ["group_size", GROUP_TEXT.size],
    ["unknown_item", GROUP_TEXT.unknownItem],
    ["board_locked", NOTICES.locked],
    ["silent_active", SILENT_TEXT.on],
    ["rate_limited", NOTICES.tooQuick],
  ])("a refused create (%s) goes, the items it took come back to their groups, with a calm notice", (code, notice) => {
    const t = withGroups([group(1, [nid(1), nid(2)])]);
    t.relay.refuseGroups = code;
    t.session.createGroup([nid(2), nid(3)]);
    expect(groupIds(t)).toEqual([gid(1)]);
    expect(t.shownGroup(gid(1))?.members).toEqual([nid(1), nid(2)]);
    expect(t.view().noteNotice).toBe(notice);
  });

  it.each([
    ["unknown_group", GROUP_TEXT.unknownGroup],
    ["unknown_item", GROUP_TEXT.unknownItem],
    ["group_size", GROUP_TEXT.size],
    ["board_locked", NOTICES.locked],
    ["silent_active", SILENT_TEXT.on],
    ["rate_limited", NOTICES.tooQuick],
  ])("a refused update, member change or ungroup (%s) rolls back", (code, notice) => {
    const t = withGroups([group(1, [nid(1), nid(2)])]);
    t.relay.refuseGroups = code;
    t.session.updateGroup(gid(1), { label: "Late", color: "pink" });
    expect(t.shownGroup(gid(1))).toMatchObject({ label: "", color: "neutral" });
    expect(t.view().noteNotice).toBe(notice);
    t.relay.refuseGroups = code;
    t.session.addToGroup(gid(1), [nid(3)]);
    expect(t.shownGroup(gid(1))?.members).toEqual([nid(1), nid(2)]);
    t.relay.refuseGroups = code;
    t.session.ungroup([gid(1)]);
    expect(groupIds(t)).toEqual([gid(1)]);
  });

  it("an update sends only what changed; members add and remove; ungroup deletes the group and keeps the items", () => {
    const t = withGroups([group(1, [nid(1), nid(2)])]);
    t.session.updateGroup(gid(1), { label: "  Customer\nthemes ", color: "neutral" });
    expect(groupMsgs(t).at(-1)).toEqual({ type: "groupUpdate", id: gid(1), label: "Customer themes" });
    t.session.addToGroup(gid(1), [nid(3), sid(1), nid(1)]);
    expect(groupMsgs(t).at(-1)).toEqual({ type: "groupMembers", id: gid(1), add: [nid(3), sid(1)], remove: [] });
    t.session.removeFromGroup(gid(1), [nid(3)]);
    expect(groupMsgs(t).at(-1)).toEqual({ type: "groupMembers", id: gid(1), add: [], remove: [nid(3)] });
    expect(t.shownGroup(gid(1))?.members).toEqual([nid(1), nid(2), sid(1)].sort());
    t.session.ungroup([gid(1)]);
    expect(groupMsgs(t).at(-1)).toEqual({ type: "groupDelete", id: gid(1) });
    expect(groupIds(t)).toEqual([]);
    expect(t.view().board.notes).toHaveLength(4);
  });

  it("a label is cut to 40 characters and an empty one is fine", () => {
    const t = withGroups([]);
    t.session.createGroup([nid(1), nid(2)], { label: "x".repeat(60) });
    expect((groupMsgs(t)[0] as { label: string }).label).toHaveLength(40);
  });
});

describe("rules up front (nothing sent, the reason said)", () => {
  it("fewer than 2 items, unsaved items, and taking out so few stay are refused", () => {
    const t = withGroups([group(1, [nid(1), nid(2), nid(3)])]);
    expect(t.session.createGroup([nid(4)])).toBeNull();
    expect(t.view().noteNotice).toBe(GROUP_TEXT.few);
    t.relay.paused = true;
    const one = t.session.addNote({ x: 5, y: 5, color: "yellow" })!;
    const two = t.session.addNote({ x: 9, y: 9, color: "yellow" })!;
    expect(t.session.createGroup([one, two])).toBeNull();
    expect(t.view().noteNotice).toBe(GROUP_TEXT.unsaved);
    t.relay.resume();
    expect(t.session.removeFromGroup(gid(1), [nid(1), nid(2)])).toBe(false);
    expect(t.view().noteNotice).toBe(GROUP_TEXT.removeAll);
    expect(groupMsgs(t)).toEqual([]);
  });

  it(`refuses a create past ${MAX_GROUPS_PER_ROOM} groups with the reason`, () => {
    const many = notes(62);
    const groups = Array.from({ length: MAX_GROUPS_PER_ROOM }, (_, i) => group(i + 1, [nid(2 * i + 1), nid(2 * i + 2)]));
    const t = withGroups(groups, many);
    expect(t.session.createGroup([nid(61), nid(62)])).toBeNull();
    expect(t.view().noteNotice).toBe(GROUP_TEXT.full);
    expect(groupMsgs(t)).toEqual([]);
  });

  it("a guest on a locked board: every group change is refused with the lock's reason", () => {
    const t = room(notes(3), [], {}, (r) => (r.locked = true), [], [], [group(1, [nid(1), nid(2)])]);
    expect(t.session.createGroup([nid(2), nid(3)])).toBeNull();
    expect(t.view().noteNotice).toBe(LOCK_TEXT.reason);
    expect(t.session.updateGroup(gid(1), { label: "x" })).toBe(false);
    expect(t.session.ungroup([gid(1)])).toBe(false);
    expect(groupMsgs(t)).toEqual([]);
  });

  it("during a silent round every group change is refused for everyone", () => {
    const t = withGroups([group(1, [nid(1), nid(2)])]);
    t.relay.emit({ type: "silentChanged", active: true, count: 0 });
    expect(t.session.createGroup([nid(3), nid(4)])).toBeNull();
    expect(t.view().noteNotice).toBe(SILENT_TEXT.on);
    expect(t.session.addToGroup(gid(1), [nid(3)])).toBe(false);
    expect(t.session.ungroup([gid(1)])).toBe(false);
    expect(groupMsgs(t)).toEqual([]);
  });
});

describe("moving a group", () => {
  it("dragging its members sends the existing batch moves and nothing else; the members keep their group", () => {
    const t = withGroups([group(1, [nid(1), sid(1)])]);
    t.relay.received.length = 0;
    expect(t.session.startSelectionDrag([], [nid(1)], false, [sid(1)])).toBe(true);
    t.session.moveSelection(40, 10, false);
    vi.advanceTimersByTime(200);
    t.session.moveSelection(80, 20, true);
    const types = new Set(t.relay.received.map((m) => m.type));
    expect([...types].sort()).toEqual(["noteBatch", "shapeBatch"]);
    expect(t.relay.notes.get(nid(1))).toMatchObject({ x: 180, y: 120 });
    expect(t.shownGroup(gid(1))?.members).toEqual([nid(1), sid(1)].sort());
  });
});

describe("deletes, Clear board and undo", () => {
  it("deleting a member until the group dissolves; undoing the delete restores the item and re-creates the group", () => {
    const t = withGroups([group(1, [nid(1), nid(2)], { label: "Pair", color: "blue" })]);
    t.session.deleteNote(nid(1));
    expect(t.relay.groups.size).toBe(0);
    expect(groupIds(t)).toEqual([]);
    t.session.undo();
    vi.advanceTimersByTime(ITEMS_STEP_MS * 3);
    expect(t.relay.groups.size).toBe(1);
    const [g] = [...t.relay.groups.values()];
    expect(g).toMatchObject({ label: "Pair", color: "blue" });
    expect(g!.members).toHaveLength(2);
    expect(g!.members).toContain(nid(2));
    expect(g!.members.every((m) => t.relay.notes.has(m))).toBe(true);
  });

  it("deleting a member of a bigger group shrinks it; undo puts the restored item back in", () => {
    const t = withGroups([group(1, [nid(1), nid(2), nid(3)])]);
    t.session.deleteNote(nid(1));
    expect(t.relay.groups.get(gid(1))?.members).toEqual([nid(2), nid(3)]);
    t.session.undo();
    vi.advanceTimersByTime(ITEMS_STEP_MS * 3);
    expect(t.relay.groups.get(gid(1))?.members).toHaveLength(3);
  });

  it("an undo skips a group someone else changed since, and says so", () => {
    const t = withGroups([group(1, [nid(1), nid(2), nid(3)])]);
    t.session.deleteNote(nid(1));
    t.relay.samEditGroup(gid(1), { label: "Sam's" });
    t.session.undo();
    vi.advanceTimersByTime(ITEMS_STEP_MS * 3);
    expect(t.relay.groups.get(gid(1))?.members).toEqual([nid(2), nid(3)]);
    expect(t.view().historyReport?.text).toContain(HISTORY_TEXT.conflicts(1));
  });

  it("Clear board deletes the groups first, then arrows, then items; one undo restores items, arrows, then groups", () => {
    const ns = notes(4);
    const t = room(ns, [], {}, undefined, [], [connector(1, { item: nid(1), anchor: "auto" }, { item: nid(2), anchor: "auto" })], [group(1, [nid(1), nid(2)]), group(2, [nid(3), nid(4)], { label: "B" })]);
    t.relay.received.length = 0;
    expect(t.session.clearBoard()).toBe(true);
    vi.advanceTimersByTime(500);
    const order = t.relay.received.map((m) => m.type);
    expect(order.slice(0, 3)).toEqual(["groupDelete", "groupDelete", "connectorDelete"]);
    expect(order).toContain("noteBatch");
    expect(t.relay.groups.size + t.relay.notes.size + t.relay.connectors.size).toBe(0);
    t.relay.received.length = 0;
    t.session.undo();
    vi.advanceTimersByTime(3000);
    const kinds = t.relay.received.map((m) => m.type);
    expect(kinds.indexOf("itemsAdd")).toBeLessThan(kinds.indexOf("connectorAdd"));
    expect(kinds.indexOf("connectorAdd")).toBeLessThan(kinds.indexOf("groupCreate"));
    expect(t.relay.groups.size).toBe(2);
    expect([...t.relay.groups.values()].map((g) => g.label).sort()).toEqual(["", "B"]);
    expect(t.view().historyReport?.text).toBe("Restored 7 items.");
  });

  it("refuses an undo that would bring back more groups than fit, before anything moves", () => {
    const many = notes(62);
    const t = withGroups([group(1, [nid(1), nid(2)])], many);
    t.session.ungroup([gid(1)]);
    for (let i = 2; i <= MAX_GROUPS_PER_ROOM + 1; i++) t.relay.emit({ type: "groupCreated", group: group(i, [nid(2 * i - 1), nid(2 * i)]) });
    const before = t.relay.received.length;
    t.session.undo();
    expect(t.view().noteNotice).toBe(GROUP_TEXT.restoreFull(1, 0));
    expect(t.relay.received.length).toBe(before);
  });

  it("undo and redo of a create, a label edit, a member change and an ungroup", () => {
    const t = withGroups([]);
    t.session.createGroup([nid(1), nid(2)], { label: "A" });
    const id = groupIds(t)[0]!;
    t.session.updateGroup(id, { color: "green" });
    t.session.addToGroup(id, [nid(3)]);
    t.session.undo();
    expect(t.relay.groups.get(id)?.members).toEqual([nid(1), nid(2)]);
    t.session.undo();
    expect(t.relay.groups.get(id)?.color).toBe("neutral");
    t.session.undo();
    expect(t.relay.groups.size).toBe(0);
    t.session.redo();
    expect(t.relay.groups.size).toBe(1);
    const again = [...t.relay.groups.keys()][0]!;
    t.session.ungroup([again]);
    expect(t.relay.groups.size).toBe(0);
    t.session.undo();
    expect([...t.relay.groups.values()][0]).toMatchObject({ label: "A", members: [nid(1), nid(2)] });
  });
});

describe("Duplicate", () => {
  it("copies a group only when every member is in the selection, onto the copies", () => {
    const t = withGroups([group(1, [nid(1), nid(2)], { label: "Pair" }), group(2, [nid(3), nid(4)])]);
    const ids = t.session.duplicateSelection([nid(1), nid(2), nid(3)], [], [sid(1)]);
    expect(ids).not.toBeNull();
    vi.advanceTimersByTime(1000);
    expect(t.relay.groups.size).toBe(3);
    const copy = [...t.relay.groups.values()].find((g) => g.id !== gid(1) && g.id !== gid(2))!;
    expect(copy.label).toBe("Pair");
    expect(copy.members.some((m) => m === nid(1) || m === nid(2))).toBe(false);
    // One undo removes the copies and their group.
    t.session.undo();
    vi.advanceTimersByTime(1000);
    expect(t.relay.groups.size).toBe(2);
  });

  it("refuses a duplicate that would pass the group cap, with the reason", () => {
    const many = notes(62);
    const groups = Array.from({ length: MAX_GROUPS_PER_ROOM }, (_, i) => group(i + 1, [nid(2 * i + 1), nid(2 * i + 2)]));
    const t = withGroups(groups, many);
    expect(t.session.duplicateSelection([nid(1), nid(2)], [])).toBeNull();
    expect(t.view().noteNotice).toBe(GROUP_TEXT.duplicateFull(1, 0));
    expect(t.relay.received.filter((m) => m.type === "itemsAdd")).toEqual([]);
  });
});
