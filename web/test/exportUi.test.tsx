// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXPORT_CLASS, EXPORT_NOTICES } from "../src/export/png";
import { BOARD_FILE_FORMAT } from "../src/export/boardFile";
import { SILENT_TEXT } from "../src/silent/silent";
import { CODE, ROOM_ID, alex, byText, cleanupUi, click, frameAt, inRoom, installUi, isOff, noteAt, sam, server, settle, shapeAt } from "./helpers/ui";

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
const jsonButton = () => section()?.querySelector<HTMLButtonElement>('[data-export="json"]') ?? null;
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
  it("is in Properties with nothing selected, with its three buttons as 44px targets", async () => {
    await inRoom(board);
    expect(section()).not.toBeNull();
    expect(section()!.closest('aside[aria-label="Properties"]')).not.toBeNull();
    for (const b of [pngButton(), mdButton(), jsonButton()]) {
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
    expect(isOff(jsonButton())).toBe(true);
    expect(reasonOf(jsonButton())).toBe(EXPORT_NOTICES.empty);
  });

  it("isn't in Properties on phones (they have the menu's Export board)", async () => {
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
    expect(status()?.textContent).toBe(EXPORT_NOTICES.pngFailed);
    expect(status()?.textContent).not.toContain("exploded");
    expect(isOff(pngButton())).toBe(false);
    expect(isOff(mdButton())).toBe(false);
    expect(isOff(jsonButton())).toBe(false);
  });
});

describe("Export board file (JSON)", () => {
  it("downloads stickyard-board-<date>.json: the board's content, no room code, names, authors or ids; nothing sent", async () => {
    const socket = await inRoom(board);
    const sent = socket.sent.length;
    await click(jsonButton());
    expect(downloads).toHaveLength(1);
    const { name, blob } = downloads[0]!;
    expect(name).toMatch(/^stickyard-board-\d{4}-\d{2}-\d{2}\.json$/);
    expect(blob.type).toContain("application/json");
    const text = await blob.text();
    const file = JSON.parse(text) as { format: string; formatVersion: number; notes: { text: string }[]; frames: { title: string }[]; shapes: unknown[] };
    expect(file.format).toBe(BOARD_FILE_FORMAT);
    expect(file.formatVersion).toBe(1);
    expect(file.notes.map((n) => n.text).sort()).toEqual(["First idea\nwith detail", "Second idea"]);
    expect(file.frames.map((f) => f.title)).toEqual(["Ideas"]);
    expect(file.shapes).toHaveLength(1);
    for (const bad of [CODE, ROOM_ID, "Alex", "Sam", alex.id, sam.id, ...board.notes.map((n) => n.id), ...board.frames.map((f) => f.id), ...board.shapes.map((x) => x.id)]) {
      expect(text).not.toContain(bad);
      expect(name).not.toContain(bad);
    }
    expect(status()?.textContent).toBe(EXPORT_NOTICES.jsonDone);
    expect(socket.sent.length).toBe(sent);
  });

  it("is off during a silent round, with the same reason as the other exports", async () => {
    await inRoom({ ...board, silent: { active: true, count: 0 } });
    for (const b of [pngButton(), mdButton(), jsonButton()]) {
      expect(isOff(b)).toBe(true);
      expect(reasonOf(b)).toBe(SILENT_TEXT.export);
    }
  });
});

describe("Export on phones", () => {
  const sheet = () => document.querySelector<HTMLElement>("[data-export-sheet]");
  const menuItem = () => byText('[role="menuitem"]', "Export board");
  async function openFromMenu() {
    await click(document.querySelector<HTMLElement>('header button[aria-label^="Menu"]'));
    await click(menuItem());
    await settle();
  }
  const stubShare = (canShare: (data: ShareData) => boolean, share: (data: ShareData) => Promise<void> = async () => {}) => {
    const shared: ShareData[] = [];
    Object.assign(navigator, {
      canShare: vi.fn(canShare),
      share: vi.fn(async (data: ShareData) => {
        await share(data);
        shared.push(data);
      }),
    });
    return shared;
  };
  afterEach(() => {
    delete (navigator as { canShare?: unknown }).canShare;
    delete (navigator as { share?: unknown }).share;
  });

  it("opens from the menu as a sheet with PNG, Markdown and board file as 44px targets", async () => {
    await inRoom({ ...board, isWide: false });
    await openFromMenu();
    expect(sheet()).not.toBeNull();
    expect(sheet()!.closest('[role="dialog"]')).not.toBeNull();
    for (const b of [pngButton(), mdButton(), jsonButton()]) {
      expect(b?.className).toContain("h-touch");
      expect(isOff(b)).toBe(false);
    }
    expect(status()?.getAttribute("aria-live")).toBe("polite");
  });

  it("works for a guest on a locked board and while disconnected", async () => {
    const socket = await inRoom({ ...board, isWide: false, locked: true });
    await openFromMenu();
    expect(isOff(mdButton())).toBe(false);
    await server(socket, "close");
    expect(isOff(jsonButton())).toBe(false);
    await click(jsonButton());
    expect(downloads).toHaveLength(1);
  });

  it("is off during a silent round, saying why", async () => {
    await inRoom({ ...board, isWide: false, silent: { active: true, count: 0 } });
    await openFromMenu();
    for (const b of [pngButton(), mdButton(), jsonButton()]) {
      expect(isOff(b)).toBe(true);
      expect(reasonOf(b)).toBe(SILENT_TEXT.export);
    }
  });

  it("shares where the browser can share the file, and downloads where it can't", async () => {
    // As Android Chrome: images share, .json and .md files don't.
    const shared = stubShare((data) => data.files?.every((f) => f.type.startsWith("image/")) ?? false);
    await inRoom({ ...board, isWide: false });
    await openFromMenu();
    await click(pngButton());
    await settle();
    expect(shared).toHaveLength(1);
    expect(shared[0]!.files![0]!.name).toMatch(/^stickyard-board-\d{4}-\d{2}-\d{2}\.png$/);
    expect(downloads).toHaveLength(0);
    expect(status()?.textContent).toBe(EXPORT_NOTICES.pngShared);
    await click(jsonButton());
    await settle();
    expect(shared).toHaveLength(1);
    expect(downloads.map((d) => d.name)).toEqual([expect.stringMatching(/\.json$/)]);
    expect(status()?.textContent).toBe(EXPORT_NOTICES.jsonDone);
  });

  it("a cancelled share sheet says so and downloads nothing", async () => {
    stubShare(
      () => true,
      () => Promise.reject(Object.assign(new Error("AbortError"), { name: "AbortError" })),
    );
    await inRoom({ ...board, isWide: false });
    await openFromMenu();
    await click(mdButton());
    await settle();
    expect(downloads).toHaveLength(0);
    expect(status()?.textContent).toBe(EXPORT_NOTICES.cancelled);
  });

  it("when the share needs a fresh tap, a Share button takes it", async () => {
    let refuse = true;
    const shared = stubShare(
      () => true,
      () => (refuse ? Promise.reject(Object.assign(new Error("NotAllowedError"), { name: "NotAllowedError" })) : Promise.resolve()),
    );
    await inRoom({ ...board, isWide: false });
    await openFromMenu();
    await click(pngButton());
    await settle();
    expect(shared).toHaveLength(0);
    const again = section()?.querySelector<HTMLButtonElement>("[data-export-again]") ?? null;
    expect(again?.textContent).toContain("Share PNG");
    expect(again?.className).toContain("h-touch");
    expect(status()?.textContent).toBe(EXPORT_NOTICES.ready("PNG"));
    refuse = false;
    await click(again);
    await settle();
    expect(shared).toHaveLength(1);
    expect(section()?.querySelector("[data-export-again]")).toBeNull();
    expect(status()?.textContent).toBe(EXPORT_NOTICES.pngShared);
  });

  it("a PNG this phone can't draw gets a calm notice pointing to Markdown and the board file", async () => {
    await inRoom({ ...board, isWide: false });
    await openFromMenu();
    toBlob.mockImplementationOnce(async () => {
      throw new RangeError("out of memory");
    });
    await click(pngButton());
    await settle();
    expect(status()?.textContent).toBe(EXPORT_NOTICES.pngFailed);
    expect(EXPORT_NOTICES.pngFailed).toMatch(/Markdown/);
    expect(EXPORT_NOTICES.pngFailed).toMatch(/board file/);
    expect(isOff(mdButton())).toBe(false);
    expect(isOff(jsonButton())).toBe(false);
    await click(mdButton());
    expect(downloads).toHaveLength(1);
  });
});
