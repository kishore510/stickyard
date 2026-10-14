// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NOTE_DEFAULTS, shapeDefaults, type Group, type Note, type Shape } from "@stickyard/shared";
import { EMPTY_BOARD, applySnapshot, type Board } from "../src/notes/board";
import { applyShapesSnapshot } from "../src/shapes/board";
import {
  addGroupLocal,
  applyGroupCreated,
  applyGroupDeleted,
  applyGroupUpdated,
  applyGroupsSnapshot,
  deleteGroupLocal,
  discardUnconfirmedGroups,
  rejectGroupCreate,
  renameItemInGroups,
  rollbackGroup,
  updateGroupLocal,
} from "../src/groups/board";
import { GROUP_PAD, chipText, groupBox, groupEffects, groupName, groupOfSelection, itemBoxes, labelMode, ungroupedBy, wholeGroups } from "../src/groups/geometry";
import { GROUP_TEXT, createReason, groupKey, groupReason, ungroupedLine } from "../src/groups/rules";
import { decodeMembers, groupFields, renameMemberRefs } from "../src/groups/fields";
import { GROUP_PACE, GroupPacer, membersOf, type GroupMessage } from "../src/groups/pace";
import { confirmDelete, confirmDeleteNotes } from "../src/notes/label";
import { confirmShapeDelete } from "../src/shapes/label";
import { confirmDeleteSelection } from "../src/canvas/frameSelect";
import { LOCK_TEXT } from "../src/facilitation/lock";
import { SILENT_TEXT } from "../src/silent/silent";

/*
 * Groups part 2 (web only): the pure parts. Reducers by rev with exclusive membership, the box
 * from the members' live boxes, label zoom levels, the delete effects, G and Shift+G, the
 * dissolve line in delete confirms, and pacing under the relay's own GROUP_LIMITS.
 */

const note = (i: number, x: number, y: number, extra: Partial<Note> = {}): Note => ({ id: `N${i}`, x, y, ...NOTE_DEFAULTS, text: `n${i}`, color: "yellow", z: i, rev: 1, authorId: "A", ...extra });
const shape = (i: number, x: number, y: number): Shape => ({ id: `S${i}`, kind: "rect", x, y, ...shapeDefaults("rect"), text: "", z: 10 + i, rev: 1, authorId: "A" });
const g = (id: string, members: string[], extra: Partial<Group> = {}): Group => ({ id, label: "", color: "neutral", members: [...members].sort(), rev: 1, ...extra });

function board(groups: Group[] = []): Board {
  const b = applyShapesSnapshot(applySnapshot(EMPTY_BOARD, [note(1, 100, 100), note(2, 400, 100), note(3, 100, 400), note(4, 700, 700)]), [shape(1, 1000, 100)]);
  return applyGroupsSnapshot(b, groups);
}

describe("group reducers", () => {
  it("a snapshot replaces confirmed groups and keeps creates still waiting", () => {
    const local = addGroupLocal(board([g("G1", ["N1", "N2"])]), { clientRef: "r1", label: "", color: "neutral", members: ["N3", "N4"] }).board;
    const next = applyGroupsSnapshot(local, [g("G2", ["N1", "N2"])]);
    expect(next.groups.map((e) => e.group.id)).toEqual(["local:r1", "G2"]);
  });

  it("updates apply by rev; older or equal ones and unknown ids are ignored", () => {
    const b = board([g("G1", ["N1", "N2"], { rev: 3 })]);
    expect(applyGroupUpdated(b, g("G1", ["N1", "N2"], { rev: 3, label: "x" }))).toBe(b);
    expect(applyGroupUpdated(b, g("G9", ["N1", "N2"], { rev: 9 }))).toBe(b);
    expect(applyGroupUpdated(b, g("G1", ["N1", "N2"], { rev: 4, label: "x" })).groups[0]?.group.label).toBe("x");
    expect(applyGroupDeleted(b, "G9")).toBe(b);
    expect(applyGroupDeleted(b, "G1").groups).toEqual([]);
  });

  it("membership is exclusive: a created or updated group takes its items from the others", () => {
    const b = board([g("G1", ["N1", "N2", "N3"])]);
    const next = applyGroupCreated(b, g("G2", ["N3", "N4"]));
    expect(next.groups.find((e) => e.group.id === "G1")?.group.members).toEqual(["N1", "N2"]);
  });

  it("a local create takes items from other groups and shows a group left with one as gone; a refusal puts all back", () => {
    const b = board([g("G1", ["N1", "N2"])]);
    const { board: next, touched } = addGroupLocal(b, { clientRef: "r1", label: "", color: "neutral", members: ["N2", "N3"] });
    expect(touched).toEqual(["G1"]);
    expect(next.groups.map((e) => e.group.id)).toEqual(["local:r1"]);
    const back = rollbackGroup(rejectGroupCreate(next, "r1"), "G1");
    expect(back.groups.map((e) => [e.group.id, e.group.members])).toEqual([["G1", ["N1", "N2"]]]);
  });

  it("local update, delete, rename of a member's id and the drop's discard", () => {
    let b = board([g("G1", ["N1", "N2"])]);
    b = updateGroupLocal(b, "G1", { label: "L", members: ["N2", "N1", "N3"] });
    expect(b.groups[0]?.group).toMatchObject({ label: "L", members: ["N1", "N2", "N3"] });
    expect(updateGroupLocal(b, "G1", { label: "L" })).toBe(b);
    b = deleteGroupLocal(b, "G1");
    b = addGroupLocal(b, { clientRef: "r2", label: "", color: "blue", members: ["local:a", "N4"] }).board;
    b = renameItemInGroups(b, "local:a", "N9");
    expect(b.groups.at(-1)?.group.members).toEqual(["N4", "N9"]);
    const discarded = discardUnconfirmedGroups(b);
    expect(discarded.groups.map((e) => e.group)).toEqual([g("G1", ["N1", "N2"])]);
  });
});

describe("the box, the chip and selection rules", () => {
  it("the box is the members' live boxes plus the padding; members not on the board are left out", () => {
    const b = board();
    const box = groupBox(["N1", "N2", "gone"], itemBoxes(b));
    expect(box).toEqual({ x: 100 - GROUP_PAD, y: 100 - GROUP_PAD, w: 300 + NOTE_DEFAULTS.w + 2 * GROUP_PAD, h: NOTE_DEFAULTS.h + 2 * GROUP_PAD });
    expect(groupBox(["gone"], itemBoxes(b))).toBeNull();
  });

  it("the label: whole from 50%, a summary below, hidden below 25%; plain text, never markup", () => {
    expect([labelMode(1), labelMode(0.5), labelMode(0.49), labelMode(0.25), labelMode(0.24)]).toEqual(["full", "full", "summary", "summary", "hidden"]);
    const hostile = "<img src=x onerror=alert(1)>";
    expect(chipText(hostile, "full")).toBe(hostile);
    expect(chipText(hostile, "summary")).toBe("<img src=x o…");
    expect(chipText("", "full")).toBe(GROUP_TEXT.untitled);
    expect(chipText("Anything", "hidden")).toBe("");
    expect(groupName({ label: hostile, members: ["a", "b"] })).toBe(`Group: ${hostile}, 2 members`);
  });

  it("what a delete does to groups: dissolved below 2, or shrunk", () => {
    const b = board([g("G1", ["N1", "N2"]), g("G2", ["N3", "N4", "S1"])]);
    const effects = groupEffects(b, ["N1", "N3"]);
    expect(effects.dissolved.map((x) => x.id)).toEqual(["G1"]);
    expect(effects.shrunk).toEqual([{ group: b.groups[1]!.confirmed, members: ["N4", "S1"] }]);
    expect(ungroupedBy(b, ["N1", "N3"])).toBe(1);
    expect(ungroupedBy(b, ["N3"])).toBe(0);
  });

  it("the selection is a group when it's exactly its members; Duplicate copies only whole groups", () => {
    const b = board([g("G1", ["N1", "N2"]), g("G2", ["N3", "S1"])]);
    expect(groupOfSelection(b, ["N2", "N1"])).toBe("G1");
    expect(groupOfSelection(b, ["N1"])).toBeNull();
    expect(groupOfSelection(b, ["N1", "N2", "N3"])).toBeNull();
    expect(wholeGroups(b, ["N1", "N2", "N3"]).map((x) => x.id)).toEqual(["G1"]);
  });
});

describe("rules and texts", () => {
  const e = (key: string, extra: Partial<KeyboardEvent> = {}) => ({ key, target: null, defaultPrevented: false, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...extra });
  const state = { multi: true, modal: false, board: null };

  it("G groups and Shift+G ungroups, md and up, never with Ctrl, Cmd or Alt, in a field or a modal", () => {
    expect(groupKey(e("g"), state)).toBe("group");
    expect(groupKey(e("G", { shiftKey: true }), state)).toBe("ungroup");
    expect(groupKey(e("g", { ctrlKey: true }), state)).toBeNull();
    expect(groupKey(e("g", { metaKey: true }), state)).toBeNull();
    expect(groupKey(e("g", { altKey: true }), state)).toBeNull();
    expect(groupKey(e("g"), { ...state, multi: false })).toBeNull();
    expect(groupKey(e("g"), { ...state, modal: true })).toBeNull();
    const field = document.createElement("input");
    expect(groupKey({ ...e("g"), target: field }, state)).toBeNull();
    expect(groupKey(e("h"), state)).toBeNull();
  });

  it("reasons: not connected, the lock, the silent round; then the selection's own", () => {
    expect(groupReason({ live: true, lockedOut: true, silent: true })).toBe(LOCK_TEXT.reason);
    expect(groupReason({ live: true, lockedOut: false, silent: true })).toBe(SILENT_TEXT.on);
    expect(groupReason({ live: true, lockedOut: false, silent: false })).toBeNull();
    const base = { base: null, items: 2, unsaved: false, already: false, count: 0 };
    expect(createReason({ ...base, items: 1 })).toBe(GROUP_TEXT.few);
    expect(createReason({ ...base, already: true })).toBe(GROUP_TEXT.already);
    expect(createReason({ ...base, unsaved: true })).toBe(GROUP_TEXT.unsaved);
    expect(createReason({ ...base, count: 30 })).toBe(GROUP_TEXT.full);
    expect(createReason(base)).toBeNull();
  });

  it("delete confirms add how many groups a delete ungroups", () => {
    const asked: string[] = [];
    const confirm = (m: string) => {
      asked.push(m);
      return true;
    };
    expect(ungroupedLine(1)).toBe("1 group will be ungrouped.");
    expect(ungroupedLine(2)).toBe("2 groups will be ungrouped.");
    // An empty note alone would go without asking; in a group that it dissolves, it asks.
    confirmDelete("", confirm, 0, 1);
    confirmDeleteNotes(3, confirm, 0, 2);
    confirmShapeDelete({ kind: "rect", text: "" }, confirm, 0, 1);
    confirmDeleteSelection({ notes: 2, frames: 1, staying: 0, ungrouped: 1 }, confirm);
    expect(asked).toHaveLength(4);
    expect(asked[0]).toContain("1 group will be ungrouped.");
    expect(asked[1]).toContain("2 groups will be ungrouped.");
    expect(asked[3]).toContain("1 group will be ungrouped.");
    expect(confirmDelete("", () => false, 0, 0)).toBe(true);
  });

  it("history fields keep members as sorted ids and follow an item's new id", () => {
    const f = groupFields({ label: "L", color: "pink", members: ["b", "a"] });
    expect(f).toEqual({ label: "L", color: "pink", members: '["a","b"]' });
    expect(decodeMembers(renameMemberRefs(f, "a", "z").members)).toEqual(["b", "z"]);
    expect(renameMemberRefs(f, "q", "z")).toBe(f);
    expect(decodeMembers("not json")).toBeNull();
  });
});

/** The relay's GROUP_LIMITS, read from the Worker's source (the page can't import it). */
function relayLimits() {
  const source = readFileSync(new URL("../../worker/src/limits.ts", import.meta.url), "utf8");
  const block = /GROUP_LIMITS = \{([^}]*)\}/.exec(source)?.[1] ?? "";
  const n = (k: string) => Number(new RegExp(`${k}:\\s*([\\d.]+)`).exec(block)?.[1]);
  return { refillPerSecond: n("refillPerSecond"), burst: n("burst"), membersPerSecond: n("membersPerSecond"), membersBurst: n("membersBurst") };
}

function clock() {
  let now = 0;
  let timers: { at: number; fn: () => void; id: number }[] = [];
  let next = 1;
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => {
      const id = next++;
      timers.push({ at: now + ms, fn, id });
      return id;
    },
    clearTimer: (id: unknown) => {
      timers = timers.filter((t) => t.id !== id);
    },
    advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const due = timers.filter((t) => t.at <= until).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers = timers.filter((t) => t !== due);
        now = due.at;
        due.fn();
      }
      now = until;
    },
  };
}

/** Replays sends through the relay's own two buckets: false if any message would be refused. */
function relayAccepts(sends: readonly { at: number; members: number }[], l: ReturnType<typeof relayLimits>): boolean {
  let tokens = l.burst;
  let members = l.membersBurst;
  let at = 0;
  for (const s of sends) {
    tokens = Math.min(l.burst, tokens + ((s.at - at) / 1000) * l.refillPerSecond);
    members = Math.min(l.membersBurst, members + ((s.at - at) / 1000) * l.membersPerSecond);
    at = s.at;
    if (tokens < 1 || members < s.members) return false;
    tokens -= 1;
    members -= s.members;
  }
  return true;
}

describe("GroupPacer", () => {
  it("stays inside the relay's GROUP_LIMITS (read from the Worker)", () => {
    const l = relayLimits();
    expect(GROUP_PACE.burst).toBeLessThan(l.burst);
    expect(GROUP_PACE.perSecond).toBeLessThan(l.refillPerSecond);
    expect(GROUP_PACE.membersBurst).toBeLessThan(l.membersBurst);
    expect(GROUP_PACE.membersPerSecond).toBeLessThan(l.membersPerSecond);
  });

  it("Clear board's 30 ungroups go at once; 100 creates of 10 members each are paced so the relay accepts every one", () => {
    const c = clock();
    const sends: { at: number; members: number }[] = [];
    const pacer = new GroupPacer({ ...c, send: (m) => sends.push({ at: c.now(), members: membersOf(m) }) });
    for (let i = 0; i < 30; i++) pacer.enqueue({ type: "groupDelete", id: `G${i}` } as GroupMessage);
    expect(sends).toHaveLength(30);
    const members = Array.from({ length: 10 }, (_, i) => `M${i}`);
    for (let i = 0; i < 100; i++) pacer.enqueue({ type: "groupCreate", clientRef: `r${i}`, label: "", color: "neutral", members });
    let done = false;
    pacer.whenSent(() => (done = true));
    c.advance(5 * 60_000);
    expect(sends).toHaveLength(130);
    expect(done).toBe(true);
    expect(relayAccepts(sends, relayLimits())).toBe(true);
  });

  it("a reset drops what's queued and fills both buckets", () => {
    const c = clock();
    const sends: GroupMessage[] = [];
    const pacer = new GroupPacer({ ...c, send: (m) => sends.push(m), pace: { burst: 1, perSecond: 1, membersBurst: 10, membersPerSecond: 1 } });
    pacer.enqueue({ type: "groupDelete", id: "a" });
    pacer.enqueue({ type: "groupDelete", id: "b" });
    expect(pacer.queued).toBe(1);
    pacer.reset();
    c.advance(5000);
    expect(sends.map((m) => (m as { id: string }).id)).toEqual(["a"]);
  });
});
