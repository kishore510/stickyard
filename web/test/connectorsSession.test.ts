// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONNECTOR_DEFAULTS, MAX_CONNECTORS_PER_ROOM, type Connector } from "@stickyard/shared";
import { CONNECTOR_PACE } from "../src/connectors/pace";
import { CONNECTOR_TEXT } from "../src/connectors/rules";
import { LOCK_TEXT } from "../src/facilitation/lock";
import { HISTORY_TEXT } from "../src/history/history";
import { SILENT_TEXT } from "../src/silent/silent";
import { CLEAR_FRAME_STEP_MS, ITEMS_STEP_MS, NOTICES, UNDO_TEXT } from "../src/rooms/session";
import { cid, connector, frame, nid, note, room, sam, shape, sid } from "./helpers/fakeRelay";

/*
 * Arrows part 2 (web only): the session's arrows. The fake relay stores and answers like the
 * Worker (v0.35.0): connectorAdd/Update/Delete, refusals by code, and the delete rule (ends bound
 * to a deleted note or shape turn free, connectorUpdated after the item's delete).
 */

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const free = (x: number, y: number) => ({ x, y });
const bound = (item: string, anchor: "auto" | "top" | "right" | "bottom" | "left" = "auto") => ({ item, anchor });
const withArrows = (arrows: Connector[], notes = [note(1), note(2, { x: 400 })]) => room(notes, [], {}, undefined, [], arrows);
const ids = (t: ReturnType<typeof room>) => t.view().board.connectors.map((c) => c.connector.id);

describe("session state from the relay", () => {
  it("the join's connectorsSnapshot fills the board; a reconnect's replaces it", () => {
    const t = withArrows([connector(1, bound(nid(1)), bound(nid(2))), connector(2, free(5, 5), free(90, 90))]);
    expect(ids(t)).toEqual([cid(1), cid(2)]);
    t.relay.connectors.delete(cid(2));
    t.relay.drop();
    vi.advanceTimersByTime(1300);
    t.relay.open();
    expect(t.view().status).toBe("joined");
    expect(ids(t)).toEqual([cid(1)]);
  });

  it("connectorAdded, connectorUpdated (by rev) and connectorDeleted from someone else; unknown ids ignored", () => {
    const t = withArrows([connector(1, free(5, 5), free(90, 90))]);
    t.relay.emit({ type: "connectorAdded", connector: connector(2, free(1, 1), free(2, 2)) });
    t.relay.samEditConnector(cid(1), { dash: "dotted" });
    expect(t.arrow(cid(1))?.dash).toBe("dotted");
    t.relay.emit({ type: "connectorUpdated", connector: connector(1, free(5, 5), free(90, 90), { rev: 1 }) });
    expect(t.arrow(cid(1))?.dash).toBe("dotted");
    const before = t.view().board;
    t.relay.emit({ type: "connectorUpdated", connector: connector(9, free(5, 5), free(90, 90), { rev: 7 }) });
    t.relay.emit({ type: "connectorDeleted", id: cid(9) });
    expect(t.view().board.connectors).toEqual(before.connectors);
    t.relay.emit({ type: "connectorDeleted", id: cid(2) });
    expect(ids(t)).toEqual([cid(1)]);
  });
});

describe("optimistic add, update and delete, and each rollback", () => {
  it("an add shows at once with a local id, then takes the server id", () => {
    const t = withArrows([]);
    const local = t.session.addConnector({ start: bound(nid(1), "right"), end: bound(nid(2), "left") });
    expect(local).toMatch(/^local:/);
    const sent = t.sent("connectorAdd")[0];
    expect(sent).toMatchObject({ start: bound(nid(1), "right"), end: bound(nid(2), "left"), ...CONNECTOR_DEFAULTS });
    expect(ids(t)).toHaveLength(1);
    expect(ids(t)[0]).not.toMatch(/^local:/);
    expect(t.relay.connectors.size).toBe(1);
  });

  it.each([
    ["connectors_full", CONNECTOR_TEXT.full],
    ["board_locked", NOTICES.locked],
    ["silent_active", SILENT_TEXT.on],
    ["rate_limited", NOTICES.tooQuick],
    ["unknown_item", CONNECTOR_TEXT.unknownItem],
  ])("a refused add (%s) goes, with a calm notice", (code, notice) => {
    const t = withArrows([]);
    t.relay.refuseConnectors = code;
    t.session.addConnector({ start: free(10, 10), end: free(200, 200) });
    expect(t.view().board.connectors).toEqual([]);
    expect(t.view().noteNotice).toBe(notice);
  });

  it.each([["board_locked"], ["silent_active"], ["rate_limited"], ["unknown_item"]])("a refused update or delete (%s) rolls back", (code) => {
    const t = withArrows([connector(1, free(5, 5), free(90, 90))]);
    t.relay.refuseConnectors = code;
    t.session.updateConnector(cid(1), { width: "thick" });
    expect(t.arrow(cid(1))?.width).toBe("medium");
    t.relay.refuseConnectors = code;
    t.session.deleteConnectors([cid(1)]);
    expect(ids(t)).toEqual([cid(1)]);
    expect(t.view().noteNotice).not.toBeNull();
  });

  it("an update sends only what changed; a style for several is one step; Reverse swaps ends and heads", () => {
    const t = withArrows([connector(1, free(5, 5), free(90, 90)), connector(2, bound(nid(1)), free(300, 300), { dash: "dashed" })]);
    t.session.updateConnector(cid(1), { end: free(120, 90), width: "medium" });
    expect(t.sent("connectorUpdate").at(-1)).toEqual({ type: "connectorUpdate", id: cid(1), end: free(120, 90) });
    t.session.updateConnectors([cid(1), cid(2)], { dash: "dashed" });
    expect(t.sent("connectorUpdate").slice(1)).toEqual([{ type: "connectorUpdate", id: cid(1), dash: "dashed" }]);
    t.session.reverseConnectors([cid(2)]);
    expect(t.arrow(cid(2))).toMatchObject({ start: free(300, 300), end: bound(nid(1)), startHead: "arrow", endHead: "none" });
    t.session.undo();
    expect(t.relay.connectors.get(cid(2))).toMatchObject({ start: bound(nid(1)), endHead: "arrow" });
  });

  it("moving the line of an arrow with an attached end does nothing and says why", () => {
    const t = withArrows([connector(1, bound(nid(1)), free(300, 300)), connector(2, free(5, 5), free(90, 90))]);
    expect(t.session.moveConnector(cid(1), 10, 10)).toBe(false);
    expect(t.view().noteNotice).toBe(CONNECTOR_TEXT.attachedMove);
    expect(t.sent("connectorUpdate")).toEqual([]);
    expect(t.session.moveConnector(cid(2), 10, 10)).toBe(true);
    expect(t.sent("connectorUpdate")).toEqual([{ type: "connectorUpdate", id: cid(2), start: free(15, 15), end: free(100, 100) }]);
  });

  it("both ends on one item, or zero length, are refused here with nothing sent", () => {
    const t = withArrows([]);
    expect(t.session.addConnector({ start: bound(nid(1)), end: bound(nid(1), "top") })).toBeNull();
    expect(t.view().noteNotice).toBe(CONNECTOR_TEXT.sameItem);
    expect(t.session.addConnector({ start: free(4, 4), end: free(4, 4) })).toBeNull();
    expect(t.sent("connectorAdd")).toEqual([]);
  });
});

describe("re-routing and the delete rule", () => {
  it("dragging a note sends nothing for its arrows", () => {
    const t = withArrows([connector(1, bound(nid(1)), bound(nid(2)))]);
    const arrows = t.view().board.connectors;
    t.session.startDrag(nid(1));
    t.session.moveNote(nid(1), 100, 100, false);
    t.session.moveNote(nid(1), 120, 140, true);
    expect(t.view().board.connectors).toBe(arrows);
    expect(t.relay.received.filter((m) => String(m.type).startsWith("connector"))).toEqual([]);
  });

  it("deleting an attached note: the relay frees the end where the note was; undo restores the note and re-attaches the arrow", () => {
    const t = withArrows([connector(1, bound(nid(1), "right"), bound(nid(2), "left"))]);
    t.session.deleteNote(nid(1));
    expect(t.arrow(cid(1))?.start).toEqual(free(170, 100));
    expect(t.view().history.undo).toBeNull();
    t.session.undo();
    vi.advanceTimersByTime(ITEMS_STEP_MS * 5);
    const restored = [...t.relay.notes.values()].find((n) => n.text === "Note 1")!;
    expect(restored.id).not.toBe(nid(1));
    expect(t.relay.connectors.get(cid(1))?.start).toEqual(bound(restored.id, "right"));
    expect(t.arrow(cid(1))?.start).toEqual(bound(restored.id, "right"));
    // Redo deletes it again; the relay frees the end again (nothing sent for the arrow).
    vi.advanceTimersByTime(1000);
    const updates = t.sent("connectorUpdate").length;
    t.session.redo();
    expect(t.relay.connectors.get(cid(1))?.start).toEqual(free(170, 100));
    expect(t.sent("connectorUpdate")).toHaveLength(updates);
  });

  it("undo skips an arrow someone else changed since, and says so", () => {
    const t = withArrows([connector(1, bound(nid(1), "right"), free(600, 600)), connector(2, bound(nid(1), "top"), free(700, 700))]);
    t.session.deleteNote(nid(1));
    t.relay.samEditConnector(cid(2), { ink: "pink" });
    t.session.undo();
    vi.advanceTimersByTime(ITEMS_STEP_MS * 5);
    const restored = [...t.relay.notes.values()].find((n) => n.text === "Note 1")!;
    expect(t.relay.connectors.get(cid(1))?.start).toEqual(bound(restored.id, "right"));
    expect(t.relay.connectors.get(cid(2))?.start).toEqual(free(90, 20));
    expect(t.view().historyReport?.text).toContain(HISTORY_TEXT.conflicts(1));
  });
});

describe("Clear board and its undo", () => {
  it("deletes the arrows first (no detach rows), then the notes, shapes and frames; one undo restores items, then arrows with the new ids", () => {
    const t = room([note(1), note(2, { x: 400 })], [frame(1)], {}, undefined, [shape(1)], [
      connector(1, bound(nid(1)), bound(nid(2))),
      connector(2, bound(nid(2)), bound(sid(1)), { dash: "dashed" }),
      connector(3, free(5, 5), free(90, 90)),
    ]);
    expect(t.session.clearBoard()).toBe(true);
    const order = t.relay.received.map((m) => m.type);
    const lastArrow = order.lastIndexOf("connectorDelete");
    expect(t.sent("connectorDelete")).toHaveLength(3);
    expect(lastArrow).toBeLessThan(order.indexOf("noteBatch"));
    expect(lastArrow).toBeLessThan(order.indexOf("shapeBatch"));
    vi.advanceTimersByTime(CLEAR_FRAME_STEP_MS * 5);
    expect(t.relay.connectors.size + t.relay.notes.size + t.relay.shapes.size + t.relay.frames.size).toBe(0);
    expect(t.view().deleteReport?.text).toBe("Cleared the board: deleted 2 notes, 1 frame, 1 shape and 3 arrows.");

    t.relay.paused = true;
    t.session.undo();
    expect(t.view().historyReport?.text).toBe(UNDO_TEXT.restoring(0, 7));
    t.relay.resume();
    vi.advanceTimersByTime(ITEMS_STEP_MS * 10);
    const sent = t.relay.received.map((m) => m.type);
    expect(sent.indexOf("connectorAdd")).toBeGreaterThan(sent.lastIndexOf("itemsAdd"));
    const byText = (text: string) => [...t.relay.notes.values(), ...t.relay.shapes.values()].find((n) => n.text === text)!.id;
    const arrows = [...t.relay.connectors.values()];
    expect(arrows.map((a) => [a.start, a.end, a.dash])).toEqual([
      [bound(byText("Note 1")), bound(byText("Note 2")), "solid"],
      [bound(byText("Note 2")), bound(byText("Step 1")), "dashed"],
      [free(5, 5), free(90, 90), "solid"],
    ]);
    expect(t.view().historyReport).toEqual({ text: UNDO_TEXT.restored(7), partial: false });
  });

  it("more arrows than the burst budget: the rest are paced, and the items wait for them", () => {
    const arrows = Array.from({ length: MAX_CONNECTORS_PER_ROOM }, (_, i) => connector(i, bound(nid(1)), free(1000 + i, 1000)));
    const t = withArrows(arrows);
    // Spend some of the budget first.
    for (let i = 0; i < 10; i++) t.session.updateConnector(cid(i), { width: "thick" });
    t.session.clearBoard();
    expect(t.sent("connectorDelete").length).toBe(CONNECTOR_PACE.burst - 10);
    expect(t.sent("noteBatch")).toEqual([]);
    vi.advanceTimersByTime(5000);
    expect(t.sent("connectorDelete")).toHaveLength(MAX_CONNECTORS_PER_ROOM);
    expect(t.sent("noteBatch")).toHaveLength(1);
    // Nothing freed: every arrow was gone before its note.
    expect(t.relay.connectors.size).toBe(0);
  });
});

describe("Duplicate with arrows", () => {
  it("copies arrows attached inside the selection (to the copies) and free ones (offset); not ones attached outside", () => {
    const t = room([note(1), note(2, { x: 400 }), note(3, { x: 800 })], [], {}, undefined, [], [
      connector(1, bound(nid(1), "right"), bound(nid(2), "left")),
      connector(2, bound(nid(2)), bound(nid(3))),
      connector(3, free(10, 500), free(200, 500), { ink: "green" }),
    ]);
    const out = t.session.duplicateSelection([nid(1), nid(2)], [], [], [cid(1), cid(2), cid(3)]);
    expect(out?.connectors).toHaveLength(2);
    vi.advanceTimersByTime(ITEMS_STEP_MS * 5);
    const copies = [...t.relay.notes.values()].filter((n) => ![nid(1), nid(2), nid(3)].includes(n.id));
    const copyOf = (x: number) => copies.find((n) => n.x === x + 24)!.id;
    const added = t.sent("connectorAdd");
    expect(added.map((a) => [a.start, a.end])).toEqual([
      [bound(copyOf(10), "right"), bound(copyOf(400), "left")],
      [free(34, 524), free(224, 524)],
    ]);
    expect(t.relay.connectors.size).toBe(5);
  });

  it("refuses up front, with the reason, a duplicate that would pass 100 arrows", () => {
    const arrows = Array.from({ length: MAX_CONNECTORS_PER_ROOM - 1 }, (_, i) => connector(i, free(10 + i, 10), free(10 + i, 900)));
    const t = withArrows(arrows);
    expect(t.session.duplicateSelection([], [], [], [cid(1), cid(2)])).toBeNull();
    expect(t.view().noteNotice).toBe(CONNECTOR_TEXT.duplicateFull(2, 1));
    expect(t.sent("connectorAdd")).toEqual([]);
  });
});

describe("the 100-arrow cap, the lock and the silent round", () => {
  it("an add past 100 is refused up front with the reason", () => {
    const t = withArrows(Array.from({ length: MAX_CONNECTORS_PER_ROOM }, (_, i) => connector(i, free(10 + i, 10), free(10 + i, 900))));
    expect(t.session.addConnector({ start: free(1, 1), end: free(500, 500) })).toBeNull();
    expect(t.view().noteNotice).toBe(CONNECTOR_TEXT.full);
    expect(t.sent("connectorAdd")).toEqual([]);
  });

  it("an undo that would restore past 100 arrows is refused up front, before the history moves on", () => {
    const t = withArrows([connector(1, free(5, 5), free(90, 90)), connector(2, free(6, 5), free(91, 90))]);
    t.session.deleteConnectors([cid(1), cid(2)]);
    for (let i = 10; i < 10 + MAX_CONNECTORS_PER_ROOM - 1; i++) t.relay.emit({ type: "connectorAdded", connector: connector(i, free(i, 1), free(i, 800)) });
    t.session.undo();
    expect(t.view().noteNotice).toBe(CONNECTOR_TEXT.restoreFull(2, 1));
    expect(t.sent("connectorAdd")).toEqual([]);
    expect(t.view().history.undo).toBeNull();
  });

  it("a guest on a locked board: arrow changes refused here with the lock's reason", () => {
    const t = room([note(1)], [], {}, (r) => (r.locked = true), [], [connector(1, free(5, 5), free(90, 90))]);
    expect(t.session.addConnector({ start: free(1, 1), end: free(500, 500) })).toBeNull();
    expect(t.view().noteNotice).toBe(LOCK_TEXT.reason);
    expect(t.session.updateConnector(cid(1), { dash: "dashed" })).toBe(false);
    t.session.deleteConnectors([cid(1)]);
    expect(t.relay.received.filter((m) => String(m.type).startsWith("connector"))).toEqual([]);
  });

  it("a silent round: every arrow change is refused for everyone, the host too", () => {
    const t = withArrows([connector(1, free(5, 5), free(90, 90))]);
    t.relay.emit({ type: "silentChanged", active: true, count: 0 });
    expect(t.session.addConnector({ start: free(1, 1), end: free(500, 500) })).toBeNull();
    expect(t.view().noteNotice).toBe(SILENT_TEXT.on);
    expect(t.session.updateConnector(cid(1), { dash: "dashed" })).toBe(false);
    t.session.deleteConnectors([cid(1)]);
    expect(ids(t)).toEqual([cid(1)]);
    expect(t.relay.received.filter((m) => String(m.type).startsWith("connector"))).toEqual([]);
  });

  it("a drop: unconfirmed arrow changes go back and queued messages are never sent", () => {
    const t = withArrows([connector(1, free(5, 5), free(90, 90))]);
    t.relay.paused = true;
    t.session.updateConnector(cid(1), { ink: "pink" });
    t.relay.drop();
    expect(t.arrow(cid(1))?.ink).toBe("neutral");
    expect(t.view().dropReport).toContain("1 change");
    expect(sam.id).toBeTruthy();
  });
});
