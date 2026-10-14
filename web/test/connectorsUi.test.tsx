// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_CONNECTORS_PER_ROOM, type Connector } from "@stickyard/shared";
import { CONNECTOR_TEXT, freedLine } from "../src/connectors/rules";
import { confirmDeleteSelection, deleteCounts } from "../src/canvas/frameSelect";
import { confirmDelete, confirmDeleteNotes } from "../src/notes/label";
import { confirmShapeDelete } from "../src/shapes/label";
import { applyConnectorsSnapshot } from "../src/connectors/board";
import { applySnapshot, EMPTY_BOARD } from "../src/notes/board";
import { LOCK_TEXT } from "../src/facilitation/lock";
import { SILENT_TEXT } from "../src/silent/silent";
import { cleanupUi, click, inRoom, installUi, noteAt, notesShown, server, settle, shapeAt, type FakeWebSocket } from "./helpers/ui";

/*
 * Arrows part 2 in the page: the arrow layer, selection, Delete, Properties, the palette's
 * Connectors tiles, the delete confirm's line about freed ends, and the lock and silent states.
 * Phones show arrows read-only. Generic text.
 */

const N0 = noteAt(0).id;
const N1 = noteAt(1).id;
const C = (i: number) => `CCCCCCCCCCCCCCC${i}`;
const arrow = (i: number, start: Connector["start"], end: Connector["end"], extra: Partial<Connector> = {}): Connector => ({
  id: C(i),
  start,
  end,
  route: "straight",
  dash: "solid",
  width: "medium",
  ink: "neutral",
  startHead: "none",
  endHead: "arrow",
  rev: 1,
  authorId: "BBBBBBBBBBBBBBBB",
  ...extra,
});
const bound = (item: string, anchor: "auto" | "right" | "left" = "auto") => ({ item, anchor });

const layer = () => document.querySelector("svg[data-connector-layer]");
const arrowsShown = () => [...document.querySelectorAll<SVGGElement>("[data-connector-id]")];
const arrowEl = (id: string) => document.querySelector<SVGGElement>(`[data-connector-id="${id}"]`);
const properties = () => document.querySelector<HTMLElement>('aside[aria-label="Properties"]');
const heading = () => properties()?.querySelector("h3")?.textContent ?? "";
const palette = () => document.querySelector<HTMLElement>('aside[aria-label="Palette"]');
const tile = (label: string) => palette()?.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`) ?? null;

async function press(el: Element, init: MouseEventInit = {}) {
  await act(async () => {
    el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "mouse", button: 0, ...init }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...init }));
  });
  await settle();
}

async function key(el: Element, k: string, init: KeyboardEventInit = {}) {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
  });
  await settle();
}

const hitOf = (id: string) => arrowEl(id)?.querySelector("[data-connector-hit]") ?? null;
const sent = (socket: FakeWebSocket, type: string) => socket.ofType(type);

beforeEach(installUi);
afterEach(cleanupUi);

describe("arrows on the canvas", () => {
  it("draws every arrow in one layer above frames and below notes, each focusable with a text-only name", async () => {
    await inRoom({
      notes: [noteAt(0, { text: "<b>Plan</b>" }), noteAt(1)],
      connectors: [arrow(1, bound(N0, "right"), bound(N1, "left")), arrow(2, { x: 100, y: 600 }, { x: 400, y: 600 }, { route: "elbow", dash: "dashed" })],
    });
    expect(layer()).not.toBeNull();
    const z = Number((layer() as SVGElement | null)?.style.zIndex);
    const noteZ = Number((notesShown()[0]?.closest(".react-flow__node") as HTMLElement | null)?.style.zIndex);
    expect(z).toBeLessThan(noteZ);
    expect(arrowsShown().map((a) => a.getAttribute("aria-label"))).toEqual(["Arrow from Yellow note: <b>Plan</b> to Yellow note: Idea 1", "Elbow arrow from a free end to a free end"]);
    expect(arrowsShown().every((a) => a.getAttribute("tabindex") === "0")).toBe(true);
    // Room text is never HTML.
    expect(document.querySelector("svg[data-connector-layer] b")).toBeNull();
    // Dash, not colour alone.
    expect(arrowEl(C(2))?.querySelector("[data-connector-line]")?.getAttribute("data-dash")).toBe("dashed");
  });

  it("a click on the line selects it (Shift adds), Escape clears, Delete deletes it", async () => {
    const socket = await inRoom({ notes: [noteAt(0), noteAt(1)], connectors: [arrow(1, bound(N0), bound(N1)), arrow(2, { x: 100, y: 600 }, { x: 400, y: 600 })] });
    await press(hitOf(C(1))!);
    expect(arrowEl(C(1))?.getAttribute("aria-pressed")).toBe("true");
    expect(heading()).toBe("Arrow");
    await press(hitOf(C(2))!, { shiftKey: true });
    expect(heading()).toBe("2 arrows");
    expect(properties()?.textContent).toContain("Reverse");
    await key(document.body, "Escape");
    expect(heading()).toBe("Board");
    await press(hitOf(C(2))!);
    await key(document.body, "Delete");
    expect(sent(socket, "connectorDelete")).toEqual([{ type: "connectorDelete", id: C(2) }]);
    expect(arrowEl(C(2))).toBeNull();
  });

  it("Properties for one arrow: route, dash, width, ink, heads and Reverse send one connectorUpdate each", async () => {
    const socket = await inRoom({ notes: [noteAt(0), noteAt(1)], connectors: [arrow(1, bound(N0), bound(N1))] });
    await press(hitOf(C(1))!);
    const fields = properties()!.querySelector<HTMLElement>("[data-connector-fields]")!;
    const pick = (label: string) => fields.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`) ?? [...fields.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
    await click(pick("Elbow"));
    await click(pick("Dotted"));
    await click(pick("Thick"));
    await click(pick("Pink ink"));
    await click(pick("Reverse"));
    expect(sent(socket, "connectorUpdate").map(({ type: _, id: __, ...rest }) => rest)).toEqual([
      { route: "elbow" },
      { dash: "dotted" },
      { width: "thick" },
      { ink: "pink" },
      { start: bound(N1), end: bound(N0), startHead: "arrow", endHead: "none" },
    ]);
  });

  it("the board summary counts the arrows against the cap", async () => {
    await inRoom({ notes: [noteAt(0)], connectors: [arrow(1, { x: 1, y: 1 }, { x: 300, y: 1 }), arrow(2, { x: 1, y: 50 }, { x: 300, y: 50 })] });
    expect(properties()?.textContent).toContain(`2 of ${MAX_CONNECTORS_PER_ROOM} arrows`);
  });

  it("phones show arrows read-only: drawn and named, but not focusable, and no Connectors tiles", async () => {
    await inRoom({ isWide: false, notes: [noteAt(0), noteAt(1)], connectors: [arrow(1, bound(N0), bound(N1))] });
    expect(arrowsShown()).toHaveLength(1);
    expect(arrowEl(C(1))?.getAttribute("tabindex")).toBeNull();
    expect(document.querySelector('[data-palette-item^="connector-"]')).toBeNull();
  });
});

describe("the palette's Connectors tiles", () => {
  it("Arrow, Line and Elbow arrow, off with the reason when locked or silent", async () => {
    await inRoom({ notes: [noteAt(0)] });
    expect([tile("Arrow"), tile("Line"), tile("Elbow arrow")].every((t) => t && !t.disabled)).toBe(true);
    await click(tile("Arrow"));
    expect(document.querySelector("[data-connector-drawing]")?.textContent).toContain(CONNECTOR_TEXT.drawHint);
    await key(document.body, "Escape");
    expect(document.querySelector("[data-connector-drawing]")).toBeNull();
  });

  it("a guest on a locked board: tiles off with the lock's reason", async () => {
    await inRoom({ locked: true, notes: [noteAt(0)] });
    expect(tile("Arrow")?.disabled).toBe(true);
    expect(tile("Arrow")?.title).toContain(LOCK_TEXT.reason);
  });

  it("a silent round: tiles off for everyone with the reason; the selected arrow's fields too", async () => {
    await inRoom({ host: true, silent: { active: true, count: 0 }, notes: [noteAt(0), noteAt(1)], connectors: [arrow(1, bound(N0), bound(N1))] });
    expect(tile("Arrow")?.disabled).toBe(true);
    expect(tile("Arrow")?.title).toContain(SILENT_TEXT.on);
    await press(hitOf(C(1))!);
    expect(properties()?.querySelector("[data-connector-reason]")?.textContent).toBe(SILENT_TEXT.on);
    expect(properties()?.querySelector<HTMLButtonElement>('[data-connector-fields] button[aria-label="Reverse"], [data-connector-fields] button')?.disabled).toBe(true);
  });

  it("at 100 arrows the tiles say why", async () => {
    const many = Array.from({ length: MAX_CONNECTORS_PER_ROOM }, (_, i) => arrow(i, { x: 10 + i, y: 10 }, { x: 10 + i, y: 900 }));
    await inRoom({ connectors: many.map((a, i) => ({ ...a, id: `CCCCCCCCCCCC${String(i).padStart(4, "0")}` })) });
    expect(tile("Arrow")?.title).toContain(CONNECTOR_TEXT.full);
  });
});

describe("deleting items with attached arrows", () => {
  it("the confirm adds a line about the arrows that keep a free end", () => {
    const ask = vi.fn(() => true);
    expect(freedLine(1)).toBe("1 arrow will keep a free end.");
    expect(freedLine(3)).toBe("3 arrows will keep a free end.");
    confirmDelete("Idea", ask, 2);
    expect(ask).toHaveBeenLastCalledWith("Delete this note? It’s removed for everyone in the session. 2 arrows will keep a free end.");
    // An empty note with attached arrows still asks, for the arrows.
    expect(confirmDelete("", ask, 1)).toBe(true);
    expect(ask).toHaveBeenLastCalledWith("Delete this note? It’s removed for everyone in the session. 1 arrow will keep a free end.");
    confirmDeleteNotes(3, ask, 1);
    expect(ask).toHaveBeenLastCalledWith("Delete 3 notes? They’re removed for everyone in the session. 1 arrow will keep a free end.");
    confirmShapeDelete({ kind: "rect", text: "" }, ask, 2);
    expect(ask).toHaveBeenLastCalledWith("Delete this shape? It’s removed for everyone in the session. 2 arrows will keep a free end.");
    const board = applyConnectorsSnapshot(applySnapshot(EMPTY_BOARD, [noteAt(0), noteAt(1)]), [arrow(1, bound(N0), bound(N1)), arrow(2, bound(N0), { x: 5, y: 5 })]);
    const counts = deleteCounts(board, [N0], [], [], [C(2)]);
    expect(counts).toMatchObject({ notes: 1, arrows: 1, freed: 1 });
    confirmDeleteSelection(counts, ask);
    expect(ask).toHaveBeenLastCalledWith("Delete 1 note and 1 arrow? They’re removed for everyone in the session. 1 arrow will keep a free end.");
  });

  it("Delete on a note with an attached arrow asks with that line", async () => {
    const ask = vi.fn(() => false);
    window.confirm = ask;
    await inRoom({ notes: [noteAt(0), noteAt(1)], shapes: [shapeAt(0)], connectors: [arrow(1, bound(N0), bound(N1))] });
    const card = notesShown()[0]!;
    await press(card);
    await key(card, "Delete");
    expect(ask).toHaveBeenCalledWith("Delete this note? It’s removed for everyone in the session. 1 arrow will keep a free end.");
  });
});

describe("the arrow announcer", () => {
  it("is polite and speaks for my own add and delete only", async () => {
    const socket = await inRoom({ notes: [noteAt(0), noteAt(1)], connectors: [arrow(1, bound(N0), bound(N1))] });
    const announcer = () => document.querySelector("[data-connector-announcer]");
    expect(announcer()?.getAttribute("aria-live")).toBe("polite");
    await server(socket, { data: { type: "connectorAdded", connector: arrow(2, { x: 1, y: 1 }, { x: 300, y: 1 }) } });
    expect(announcer()?.textContent).toBe("");
    await press(hitOf(C(1))!);
    await key(document.body, "Delete");
    expect(announcer()?.textContent).toBe(CONNECTOR_TEXT.deleted(1));
  });
});
