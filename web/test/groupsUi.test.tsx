// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Group } from "@stickyard/shared";
import { GROUP_TEXT } from "../src/groups/rules";
import { LOCK_TEXT } from "../src/facilitation/lock";
import { SILENT_TEXT } from "../src/silent/silent";
import { boardBar, cleanupUi, click, frameAt, inRoom, installUi, isOff, named, noteAt, notesShown, server, settle, shapeAt, tipOf, type FakeWebSocket } from "./helpers/ui";

/*
 * Groups part 2 in the page: the box layer and its chip, selecting a group, G and Shift+G,
 * Properties for a group, the label edited on the chip, moving by the chip, and the lock, silent
 * and phone states. Generic text; a hostile label stays text.
 */

const HOSTILE = "<img src=x onerror=alert(1)>";
const N = (i: number) => noteAt(i).id;
const G = (i: number) => `GGGGGGGGGGGGGGG${i}`;
const group = (i: number, members: string[], extra: Partial<Group> = {}): Group => ({ id: G(i), label: "", color: "neutral", members: [...members].sort(), rev: 1, ...extra });

const layer = () => document.querySelector<HTMLElement>("[data-group-layer]");
const boxEl = (id: string) => document.querySelector<HTMLElement>(`[data-group-id="${id}"]`);
const chipEl = (id: string) => boxEl(id)?.querySelector<HTMLElement>("[data-group-chip]") ?? null;
const properties = () => document.querySelector<HTMLElement>('aside[aria-label="Properties"]');
const heading = () => properties()?.querySelector("h3")?.textContent ?? "";
const groupMsgs = (socket: FakeWebSocket) => socket.sent.filter((m) => typeof m.type === "string" && m.type.startsWith("group"));

async function press(el: Element, init: MouseEventInit = {}) {
  await act(async () => {
    el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "mouse", button: 0, ...init }));
    el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, pointerType: "mouse", button: 0, ...init }));
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

async function selectNotes(...indexes: number[]) {
  for (const [n, i] of indexes.entries()) await press(notesShown()[i]!, n === 0 ? {} : { shiftKey: true });
}

beforeEach(installUi);
afterEach(cleanupUi);

describe("group boxes on the canvas", () => {
  it("draws each group in one layer above frames and below arrows and notes, its chip named by its label only", async () => {
    await inRoom({ notes: [noteAt(0), noteAt(1), noteAt(2)], frames: [frameAt(0)], groups: [group(1, [N(0), N(1)], { label: HOSTILE, color: "blue" })] });
    expect(layer()).not.toBeNull();
    const z = Number(layer()!.style.zIndex);
    const noteZ = Number((notesShown()[0]?.closest(".react-flow__node") as HTMLElement | null)?.style.zIndex);
    const frameZ = Number((document.querySelector("[data-frame-id]")?.closest(".react-flow__node") as HTMLElement | null)?.style.zIndex);
    const arrowZ = Number((document.querySelector("svg[data-connector-layer]") as SVGElement | null)?.style.zIndex);
    expect(z).toBeGreaterThan(frameZ);
    expect(z).toBeLessThan(arrowZ);
    expect(z).toBeLessThan(noteZ);
    expect(chipEl(G(1))?.getAttribute("aria-label")).toBe(`Group: ${HOSTILE}, 2 members`);
    expect(chipEl(G(1))?.textContent).toContain(HOSTILE);
    expect(layer()!.querySelector("img")).toBeNull();
    expect(chipEl(G(1))?.getAttribute("tabindex")).toBe("0");
    expect(boxEl(G(1))?.getAttribute("data-color")).toBe("blue");
  });

  it("a click on the chip selects the group: its members are selected and Properties shows the group", async () => {
    await inRoom({ notes: [noteAt(0), noteAt(1), noteAt(2)], groups: [group(1, [N(0), N(1)], { label: "Themes" })] });
    await press(chipEl(G(1))!);
    expect(heading()).toBe("Group");
    const fields = properties()!.querySelector("[data-group-fields]")!;
    expect(fields.textContent).toContain("2 members");
    expect(chipEl(G(1))?.getAttribute("aria-pressed")).toBe("true");
    expect(named("Ungroup", fields)).toBeDefined();
    expect(named("Select members", fields)).toBeDefined();
  });

  it("G groups the selected notes (a selected frame is left out, with the reason); Shift+G ungroups", async () => {
    const socket = await inRoom({ notes: [noteAt(0), noteAt(1), noteAt(2)], frames: [frameAt(0)] });
    await selectNotes(0, 1);
    await key(document.body, "g");
    expect(groupMsgs(socket)).toEqual([{ type: "groupCreate", clientRef: expect.any(String), label: "", color: "neutral", members: [N(0), N(1)] }]);
    const ref = (groupMsgs(socket)[0] as { clientRef: string }).clientRef;
    await server(socket, { data: { type: "groupCreated", group: group(1, [N(0), N(1)]), clientRef: ref } });
    await key(document.body, "G", { shiftKey: true });
    expect(groupMsgs(socket).at(-1)).toEqual({ type: "groupDelete", id: G(1) });
    // A frame in the selection is ignored, and the page says so.
    await press(notesShown()[2]!);
    await press(notesShown()[1]!, { shiftKey: true });
    const frame = document.querySelector<HTMLElement>("[data-frame-id] .sy-frame-handle");
    if (frame) await press(frame, { shiftKey: true });
    await key(document.body, "g");
    expect((groupMsgs(socket).at(-1) as { members?: string[] }).members).toEqual([N(1), N(2)]);
    expect(document.body.textContent).toContain(GROUP_TEXT.ignored);
  });

  it("the label is edited on the chip (double-click, Enter) and in Properties; the colour tints the box only", async () => {
    const socket = await inRoom({ notes: [noteAt(0), noteAt(1)], groups: [group(1, [N(0), N(1)])] });
    await act(async () => chipEl(G(1))!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    await settle();
    const edit = boxEl(G(1))!.querySelector<HTMLInputElement>("input[data-group-edit]")!;
    expect(edit.maxLength).toBe(40);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(edit, "Customer themes");
      edit.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await key(edit, "Enter");
    expect(groupMsgs(socket).at(-1)).toEqual({ type: "groupUpdate", id: G(1), label: "Customer themes" });
    await press(chipEl(G(1))!);
    await click(named("Pink", properties()!) ?? named("Pink group colour", properties()!));
    expect(groupMsgs(socket).at(-1)).toEqual({ type: "groupUpdate", id: G(1), color: "pink" });
    expect(notesShown().every((n) => !n.className.includes("pink"))).toBe(true);
  });

  it("dragging the chip moves every member with the batch move and sends nothing else", async () => {
    const socket = await inRoom({ notes: [noteAt(0), noteAt(1)], shapes: [shapeAt(0)], groups: [group(1, [N(0), N(1), shapeAt(0).id])] });
    socket.sent.length = 0;
    const chip = chipEl(G(1))!;
    await act(async () => {
      chip.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "mouse", button: 0, clientX: 10, clientY: 10 }));
      window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerType: "mouse", clientX: 60, clientY: 40 }));
      window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerType: "mouse", clientX: 110, clientY: 70 }));
      window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerType: "mouse", clientX: 110, clientY: 70 }));
    });
    await settle();
    const types = [...new Set(socket.sent.map((m) => m.type))].sort();
    expect(types).toEqual(["noteBatch", "shapeBatch"]);
  });

  it("Properties' board summary counts groups", async () => {
    await inRoom({ notes: [noteAt(0), noteAt(1)], groups: [group(1, [N(0), N(1)])] });
    expect(properties()?.textContent).toContain(GROUP_TEXT.summary(1));
  });
});

describe("when groups can't change", () => {
  it("a guest on a locked board: the bar's Group and the group's Properties are off with the lock's reason", async () => {
    await inRoom({ locked: true, notes: [noteAt(0), noteAt(1)], groups: [group(1, [N(0), N(1)])] });
    await press(chipEl(G(1))!);
    const bar = boardBar()!;
    const grp = named("Group", bar);
    expect(isOff(grp)).toBe(true);
    expect(tipOf(grp)?.textContent).toBe(LOCK_TEXT.reason);
    expect(properties()!.querySelector("[data-group-reason]")?.textContent).toBe(LOCK_TEXT.reason);
    expect(isOff(named("Ungroup", properties()!))).toBe(true);
  });

  it("a silent round turns every group control off for everyone, the host too, with the reason", async () => {
    await inRoom({ host: true, silent: { active: true, count: 0 }, notes: [noteAt(0), noteAt(1)], groups: [group(1, [N(0), N(1)])] });
    await press(chipEl(G(1))!);
    expect(tipOf(named("Group", boardBar()!))?.textContent).toBe(SILENT_TEXT.on);
    expect(properties()!.querySelector("[data-group-reason]")?.textContent).toBe(SILENT_TEXT.on);
  });

  it("phones show boxes and labels read-only", async () => {
    const socket = await inRoom({ isWide: false, notes: [noteAt(0), noteAt(1)], groups: [group(1, [N(0), N(1)], { label: "Themes" })] });
    expect(chipEl(G(1))?.textContent).toContain("Themes");
    expect(chipEl(G(1))?.getAttribute("tabindex")).toBeNull();
    await press(chipEl(G(1))!);
    await key(document.body, "G", { shiftKey: true });
    expect(groupMsgs(socket)).toEqual([]);
  });
});
