// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXPORT_CLASS, EXPORT_NOTICES } from "../src/export/png";
import { CODE, ROOM_ID, cleanupUi, click, frameAt, inRoom, installUi, isOff, noteAt, server, settle, shapeAt } from "./helpers/ui";

/*
 * Export (v0.22.0) in Properties: nothing selected, md and up, for hosts and guests, locked or
 * not, connected or not. The file goes out through a temporary link; html-to-image is mocked
 * (the real drawing is checked in Chromium).
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const toBlob = vi.fn(async (_node: HTMLElement, _options?: unknown): Promise<Blob | null> => new Blob(["png"], { type: "image/png" }));
vi.mock("html-to-image", () => ({ toBlob: (node: HTMLElement, options: unknown) => toBlob(node, options) }));

const section = () => document.querySelector<HTMLElement>("[data-export-section]");
const pngButton = () => section()?.querySelector<HTMLButtonElement>('[data-export="png"]') ?? null;
const mdButton = () => section()?.querySelector<HTMLButtonElement>('[data-export="md"]') ?? null;
const status = () => section()?.querySelector<HTMLElement>("[data-export-status]") ?? null;
const reasonOf = (el: Element | null) => document.getElementById(el?.getAttribute("aria-describedby") ?? "")?.textContent ?? "";

let downloads: { name: string; blob: Blob }[] = [];

beforeEach(() => {
  installUi();
  downloads = [];
  toBlob.mockClear();
  const blobs = new Map<string, Blob>();
  vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
    const url = `blob:fake/${blobs.size}`;
    blobs.set(url, blob as Blob);
    return url;
  });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    downloads.push({ name: this.download, blob: blobs.get(this.getAttribute("href") ?? "")! });
  });
});
afterEach(() => cleanupUi());

const board = {
  notes: [noteAt(1, { text: "First idea\nwith detail" }), noteAt(2, { text: "Second idea" })],
  frames: [frameAt(1, { title: "Ideas" })],
  shapes: [shapeAt(1, { text: "A label" })],
};

describe("the Export section", () => {
  it("is in Properties with nothing selected, with both buttons as 44px targets", async () => {
    await inRoom(board);
    expect(section()).not.toBeNull();
    expect(section()!.closest('aside[aria-label="Properties"]')).not.toBeNull();
    for (const b of [pngButton(), mdButton()]) {
      expect(b?.className).toContain("h-touch");
      expect(isOff(b)).toBe(false);
    }
    expect(status()?.getAttribute("aria-live")).toBe("polite");
  });

  it("is off on an empty board, saying why", async () => {
    await inRoom();
    expect(isOff(pngButton())).toBe(true);
    expect(isOff(mdButton())).toBe(true);
    expect(reasonOf(pngButton())).toBe(EXPORT_NOTICES.empty);
    expect(reasonOf(mdButton())).toBe(EXPORT_NOTICES.empty);
  });

  it("isn't on phones", async () => {
    await inRoom({ ...board, isWide: false });
    expect(section()).toBeNull();
  });

  it("works for a guest on a locked board, and while disconnected", async () => {
    const socket = await inRoom({ ...board, locked: true });
    expect(isOff(mdButton())).toBe(false);
    await server(socket, "close");
    expect(isOff(mdButton())).toBe(false);
    await click(mdButton());
    expect(downloads).toHaveLength(1);
  });
});

describe("Export Markdown", () => {
  it("downloads the board as stickyard-board-<date>.md, with no room code, id or names; nothing sent", async () => {
    const socket = await inRoom(board);
    const sent = socket.sent.length;
    await click(mdButton());
    expect(downloads).toHaveLength(1);
    const { name, blob } = downloads[0]!;
    expect(name).toMatch(/^stickyard-board-\d{4}-\d{2}-\d{2}\.md$/);
    expect(blob.type).toContain("text/markdown");
    const text = await blob.text();
    expect(text).toContain("## Ideas");
    expect(text).toContain("- **First idea** with detail");
    expect(text).toContain("- Rectangle: A label");
    for (const bad of [CODE, ROOM_ID, "Alex", "Sam"]) {
      expect(text).not.toContain(bad);
      expect(name).not.toContain(bad);
    }
    expect(status()?.textContent).toBe(EXPORT_NOTICES.mdDone);
    expect(socket.sent.length).toBe(sent);
  });
});

describe("Export PNG", () => {
  it("draws the viewport with the export class on only while drawing, then downloads", async () => {
    await inRoom(board);
    let during = false;
    toBlob.mockImplementationOnce(async (node: HTMLElement) => {
      during = node.classList.contains(EXPORT_CLASS) && node.classList.contains("react-flow__viewport");
      return new Blob(["png"], { type: "image/png" });
    });
    await click(pngButton());
    await settle();
    expect(toBlob).toHaveBeenCalledOnce();
    expect(during).toBe(true);
    expect(document.querySelector(`.${EXPORT_CLASS}`)).toBeNull();
    expect(downloads.map((d) => d.name)).toEqual([expect.stringMatching(/^stickyard-board-\d{4}-\d{2}-\d{2}\.png$/)]);
    expect(status()?.textContent).toBe(EXPORT_NOTICES.pngDone);
  });

  it("a failure shows a plain message, takes the class off and downloads nothing", async () => {
    await inRoom(board);
    toBlob.mockImplementationOnce(async () => {
      throw new Error("canvas exploded");
    });
    await click(pngButton());
    await settle();
    expect(document.querySelector(`.${EXPORT_CLASS}`)).toBeNull();
    expect(downloads).toHaveLength(0);
    expect(status()?.textContent).toBe(EXPORT_NOTICES.failedDetail);
    expect(status()?.textContent).not.toContain("exploded");
    expect(isOff(pngButton())).toBe(false);
  });
});
