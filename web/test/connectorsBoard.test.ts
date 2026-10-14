import { describe, expect, it } from "vitest";
import { CONNECTOR_DEFAULTS, type Connector } from "@stickyard/shared";
import {
  addConnectorLocal,
  applyConnectorAdded,
  applyConnectorDeleted,
  applyConnectorUpdated,
  applyConnectorsSnapshot,
  connectorChanges,
  deleteConnectorLocal,
  discardUnconfirmedConnectors,
  findConnector,
  rejectConnectorAdd,
  renameItemInConnectors,
  rollbackConnector,
  updateConnectorLocal,
} from "../src/connectors/board";
import { EMPTY_BOARD, localId } from "../src/notes/board";
import { cid, connector } from "./helpers/fakeRelay";

/* Arrows part 2: the page's connector model (pure reducers on the shared Board). */

const free = (x: number, y: number) => ({ x, y });
const bound = (item: string, anchor: "auto" | "top" | "right" | "bottom" | "left" = "auto") => ({ item, anchor });
const withArrows = (...list: Connector[]) => applyConnectorsSnapshot(EMPTY_BOARD, list);

describe("from the relay", () => {
  it("connectorsSnapshot replaces every confirmed arrow (no merge), keeping adds still waiting here", () => {
    let board = withArrows(connector(1, free(0, 0), free(10, 10)), connector(2, free(0, 0), free(20, 20)));
    board = addConnectorLocal(board, { clientRef: "refA", content: { start: free(5, 5), end: free(50, 50), ...CONNECTOR_DEFAULTS }, authorId: "AAAAAAAAAAAAAAAA" });
    const next = applyConnectorsSnapshot(board, [connector(3, free(1, 1), free(30, 30))]);
    expect(next.connectors.map((c) => c.connector.id)).toEqual([localId("refA"), cid(3)]);
    expect(next.connectorsRemoved).toEqual([]);
  });

  it("connectorUpdated applies by rev: newer wins, older or equal is ignored", () => {
    const board = withArrows(connector(1, free(0, 0), free(10, 10), { rev: 3 }));
    const newer = applyConnectorUpdated(board, connector(1, free(0, 0), free(99, 99), { rev: 4 }));
    expect(findConnector(newer, cid(1))?.connector.end).toEqual(free(99, 99));
    expect(applyConnectorUpdated(board, connector(1, free(0, 0), free(5, 5), { rev: 2 }))).toBe(board);
    expect(applyConnectorUpdated(board, connector(1, free(0, 0), free(5, 5), { rev: 3 }))).toBe(board);
  });

  it("unknown ids are ignored by update and delete; an add of an unknown id appends", () => {
    const board = withArrows(connector(1, free(0, 0), free(10, 10)));
    expect(applyConnectorUpdated(board, connector(9, free(0, 0), free(10, 10), { rev: 5 }))).toBe(board);
    expect(applyConnectorDeleted(board, cid(9))).toBe(board);
    expect(applyConnectorAdded(board, connector(2, free(0, 0), free(4, 4))).connectors).toHaveLength(2);
    expect(applyConnectorDeleted(board, cid(1)).connectors).toEqual([]);
  });

  it("an add with my clientRef replaces the temporary arrow in place", () => {
    let board = withArrows(connector(1, free(0, 0), free(10, 10)));
    board = addConnectorLocal(board, { clientRef: "refA", content: { start: free(5, 5), end: free(50, 50), ...CONNECTOR_DEFAULTS }, authorId: "AAAAAAAAAAAAAAAA" });
    const next = applyConnectorAdded(board, connector(2, free(5, 5), free(50, 50)), "refA");
    expect(next.connectors.map((c) => [c.connector.id, c.clientRef])).toEqual([
      [cid(1), null],
      [cid(2), null],
    ]);
  });
});

describe("optimistic changes and rollback", () => {
  it("an update shows at once and rolls back to the confirmed arrow", () => {
    const board = withArrows(connector(1, free(0, 0), free(10, 10)));
    const shown = updateConnectorLocal(board, cid(1), { dash: "dashed", end: free(40, 40) });
    expect(findConnector(shown, cid(1))?.connector).toMatchObject({ dash: "dashed", end: free(40, 40) });
    expect(findConnector(shown, cid(1))?.confirmed?.dash).toBe("solid");
    expect(findConnector(rollbackConnector(shown, cid(1)), cid(1))?.connector.dash).toBe("solid");
    expect(updateConnectorLocal(board, cid(1), { dash: "solid" })).toBe(board);
  });

  it("a delete goes at once and comes back in its place when refused", () => {
    const board = withArrows(connector(1, free(0, 0), free(10, 10)), connector(2, free(0, 0), free(20, 20)));
    const gone = deleteConnectorLocal(board, cid(1));
    expect(gone.connectors.map((c) => c.connector.id)).toEqual([cid(2)]);
    expect(rollbackConnector(gone, cid(1)).connectors.map((c) => c.connector.id)).toEqual([cid(1), cid(2)]);
  });

  it("a refused add goes; a drop goes back to what the relay confirmed", () => {
    let board = withArrows(connector(1, free(0, 0), free(10, 10)), connector(2, free(0, 0), free(20, 20)));
    board = addConnectorLocal(board, { clientRef: "refA", content: { start: free(5, 5), end: free(50, 50), ...CONNECTOR_DEFAULTS }, authorId: "AAAAAAAAAAAAAAAA" });
    expect(rejectConnectorAdd(board, "refA").connectors).toHaveLength(2);
    board = deleteConnectorLocal(updateConnectorLocal(board, cid(1), { ink: "pink" }), cid(2));
    const back = discardUnconfirmedConnectors(board);
    expect(back.connectors.map((c) => [c.connector.id, c.connector.ink])).toEqual([
      [cid(1), "neutral"],
      [cid(2), "neutral"],
    ]);
  });

  it("connectorChanges lists only what differs (ends compared by value)", () => {
    const a = connector(1, free(0, 0), bound("NNNNNNNNNNNNNNN1"));
    expect(connectorChanges(a, { ...a, start: free(0, 0), end: bound("NNNNNNNNNNNNNNN1") })).toEqual({});
    expect(connectorChanges(a, { ...a, end: bound("NNNNNNNNNNNNNNN1", "top"), width: "thick" })).toEqual({ end: bound("NNNNNNNNNNNNNNN1", "top"), width: "thick" });
  });

  it("an item's server id reaches the ends of arrows still waiting here", () => {
    let board = addConnectorLocal(EMPTY_BOARD, { clientRef: "refA", content: { start: bound("local:n1"), end: free(50, 50), ...CONNECTOR_DEFAULTS }, authorId: "AAAAAAAAAAAAAAAA" });
    board = renameItemInConnectors(board, "local:n1", "NNNNNNNNNNNNNNN1");
    expect(board.connectors[0]?.connector.start).toEqual(bound("NNNNNNNNNNNNNNN1"));
  });
});
