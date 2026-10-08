// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EXPORT_CLASS,
  EXPORT_MARGIN,
  EXPORT_MAX_PIXELS,
  EXPORT_MAX_SIDE,
  REVOKE_DELAY_MS,
  downloadBlob,
  exportBounds,
  exportSize,
  keepInExport,
  renderPng,
} from "../src/export/png";

/*
 * Export PNG (v0.22.0, web only): the pure size cap and bounds, the filter that leaves UI-only
 * parts out, and the export-mode class that always comes off. html-to-image is mocked here; the
 * real drawing is checked in Chromium (see the PR).
 */

describe("exportSize (the pixel cap)", () => {
  const within = (s: NonNullable<ReturnType<typeof exportSize>>) => {
    expect(s.width).toBeLessThanOrEqual(EXPORT_MAX_SIDE);
    expect(s.height).toBeLessThanOrEqual(EXPORT_MAX_SIDE);
    expect(s.width * s.height).toBeLessThan(EXPORT_MAX_PIXELS);
  };

  it("uses scale 2 when it fits", () => {
    expect(exportSize(1000, 600)).toEqual({ scale: 2, width: 2000, height: 1200 });
  });

  it("a wide board is held to 8,192 px across", () => {
    const s = exportSize(6000, 300)!;
    within(s);
    expect(s.width).toBe(EXPORT_MAX_SIDE);
    expect(s.scale).toBeCloseTo(EXPORT_MAX_SIDE / 6000);
  });

  it("a tall board is held to 8,192 px down", () => {
    const s = exportSize(300, 5000)!;
    within(s);
    expect(s.height).toBe(EXPORT_MAX_SIDE);
  });

  it("a huge board stays under 16 million pixels", () => {
    const s = exportSize(3200 + 2 * EXPORT_MARGIN, 2000 + 2 * EXPORT_MARGIN)!;
    within(s);
    expect(s.scale).toBeLessThan(2);
    expect(s.width * s.height).toBeGreaterThan(EXPORT_MAX_PIXELS * 0.99);
  });

  it("an empty board (or nonsense) has no size", () => {
    expect(exportSize(0, 0)).toBeNull();
    expect(exportSize(-1, 10)).toBeNull();
    expect(exportSize(Number.NaN, 10)).toBeNull();
    expect(exportSize(Infinity, 10)).toBeNull();
  });
});

describe("exportBounds", () => {
  it("covers notes, frames and shapes together, plus the margin", () => {
    const note = { x: 500, y: 400, w: 160, h: 160 };
    const frame = { x: 100, y: 300, w: 640, h: 400 };
    const shape = { x: 900, y: 50, w: 200, h: 120 };
    expect(exportBounds([note, frame, shape])).toEqual({
      x: 100 - EXPORT_MARGIN,
      y: 50 - EXPORT_MARGIN,
      width: 1100 - 100 + 2 * EXPORT_MARGIN,
      height: 700 - 50 + 2 * EXPORT_MARGIN,
    });
  });

  it("is null for an empty board", () => {
    expect(exportBounds([])).toBeNull();
  });

  it("the margin is mirrored by --sy-export-margin in tokens.css", () => {
    const tokens = readFileSync(resolve(import.meta.dirname, "../src/styles/tokens.css"), "utf8");
    expect(tokens).toContain(`--sy-export-margin: ${EXPORT_MARGIN}px;`);
  });
});

describe("keepInExport (the filter)", () => {
  const el = (html: string) => {
    const host = document.createElement("div");
    host.innerHTML = html;
    return host.firstElementChild!;
  };
  it("leaves out cursors, selection marks, handles, toolbars, the dot grid and my dots", () => {
    for (const html of [
      '<div class="react-flow__node react-flow__node-board"></div>',
      '<div class="react-flow__resize-control handle"></div>',
      '<div class="react-flow__node-toolbar"></div>',
      '<div class="sy-select-badge" data-select-badge=""></div>',
      '<div class="sy-selection-box" data-selection-box=""></div>',
      '<div class="sy-cursor" data-cursor="x"></div>',
      '<span data-my-dots="" class="sy-vote-badge"></span>',
      '<div class="react-flow__minimap"></div>',
      '<div class="react-flow__attribution"></div>',
      '<svg data-export-skip=""></svg>',
    ])
      expect(keepInExport(el(html)), html).toBe(false);
  });
  it("keeps notes, frames, shapes, totals and Top voted, and text", () => {
    for (const html of [
      '<div class="react-flow__node react-flow__node-note sy-selected"></div>',
      '<div class="react-flow__node react-flow__node-frame"></div>',
      '<div class="react-flow__node react-flow__node-shape"></div>',
      '<span data-vote-total="" class="sy-vote-badge">Total 3</span>',
      '<span data-top-voted="" class="sy-vote-badge">Top voted</span>',
    ])
      expect(keepInExport(el(html)), html).toBe(true);
    expect(keepInExport(document.createTextNode("hi"))).toBe(true);
  });
});

describe("renderPng (export mode)", () => {
  const viewport = () => {
    const v = document.createElement("div");
    v.className = "react-flow__viewport";
    document.body.append(v);
    return v;
  };
  const bounds = { x: 100, y: 50, width: 800, height: 600 };

  it("draws at 100% from the box's corner, with the class on only while drawing", async () => {
    const v = viewport();
    let during = false;
    const toBlob = vi.fn(async (node: HTMLElement, _options: unknown) => {
      during = node.classList.contains(EXPORT_CLASS);
      return new Blob(["png"], { type: "image/png" });
    });
    const blob = await renderPng(v, bounds, async () => ({ toBlob }) as never);
    expect(blob.type).toBe("image/png");
    expect(during).toBe(true);
    expect(v.classList.contains(EXPORT_CLASS)).toBe(false);
    const options = toBlob.mock.calls[0]![1] as { width: number; height: number; pixelRatio: number; filter: unknown; style: { transform: string } };
    expect(options).toMatchObject({ width: 800, height: 600, pixelRatio: 2, filter: keepInExport });
    expect(options.style.transform).toBe("translate(-100px, -50px) scale(1)");
  });

  it("takes the class off when drawing throws", async () => {
    const v = viewport();
    const toBlob = vi.fn(async () => {
      throw new Error("canvas too big");
    });
    await expect(renderPng(v, bounds, async () => ({ toBlob }) as never)).rejects.toThrow();
    expect(v.classList.contains(EXPORT_CLASS)).toBe(false);
  });

  it("takes the class off when the library can't load, and when it returns nothing", async () => {
    const v = viewport();
    await expect(renderPng(v, bounds, () => Promise.reject(new Error("offline")))).rejects.toThrow();
    expect(v.classList.contains(EXPORT_CLASS)).toBe(false);
    await expect(renderPng(v, bounds, async () => ({ toBlob: async () => null }) as never)).rejects.toThrow();
    expect(v.classList.contains(EXPORT_CLASS)).toBe(false);
  });
});

describe("downloadBlob", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  it("clicks a temporary link with the file name, removes it, and revokes the object URL", () => {
    vi.useFakeTimers();
    const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:fake");
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const clicks: { href: string; download: string }[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicks.push({ href: this.getAttribute("href")!, download: this.download });
    });
    const assign = vi.spyOn(window.location, "assign").mockImplementation(() => {});
    downloadBlob(new Blob(["x"]), "stickyard-board-2026-10-07.png");
    expect(create).toHaveBeenCalledOnce();
    expect(clicks).toEqual([{ href: "blob:fake", download: "stickyard-board-2026-10-07.png" }]);
    expect(document.querySelector("a[download]")).toBeNull();
    expect(assign).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(REVOKE_DELAY_MS);
    expect(revoke).toHaveBeenCalledWith("blob:fake");
  });
});
