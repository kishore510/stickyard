import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FRAME_COLORS,
  FRAME_DEFAULTS,
  FRAME_DEFAULT_H,
  FRAME_DEFAULT_W,
  FRAME_MIN_H,
  NOTE_ALIGNS,
  NOTE_FONT_SIZES,
  NOTE_TEXT_COLORS,
  PROTOCOL_VERSION,
  type Frame,
  type Participant,
} from "@stickyard/shared";
import type { SocketFactory, SocketHandlers } from "../src/connection/socket";
import { applyFrameUpdated, applyFramesSnapshot, findFrame, setFrameDraft } from "../src/frames/board";
import { FRAME_INK_SWATCHES, frameHeaderHeightToken, frameHeaderStyle, frameInkToken, frameRootStyle, frameTitleClasses, frameTitleStyle } from "../src/frames/style";
import { EMPTY_BOARD, applySnapshot } from "../src/notes/board";
import { NOTE_ALIGN_CLASSES, NOTE_FONT_SIZE_CLASSES, textColorToken } from "../src/notes/style";
import { useBoardUi } from "../src/canvas/uiStore";
import { RoomSession, type RoomView } from "../src/rooms/session";

/* Slice frame title styling (protocol v10): the frame's title style on the page. Generic fixtures. */

const tokens = readFileSync(join(process.cwd(), "src/styles/tokens.css"), "utf8");
const THEMES = [':root,\n[data-theme="light"]', '[data-theme="dark"]'] as const;
const theme = (selector: string): Record<string, string> => {
  const start = tokens.indexOf(selector);
  const block = tokens.slice(start, tokens.indexOf("}", start));
  return Object.fromEntries([...block.matchAll(/--sy-([\w-]+):\s*(#[0-9a-f]{6,8})\b/g)].map((m) => [m[1], m[2]]));
};
const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
};
const px = (name: string) => Number(tokens.match(new RegExp(`--sy-${name}:\\s*(\\d+)px;`))?.[1]);

const alex: Participant = { id: "AAAAAAAAAAAAAAAA", name: "Alex", colourIndex: 0, host: false };
const frameId = (i: number) => `frame${String(i).padStart(11, "0")}`;
const frame = (i: number, extra: Partial<Frame> = {}): Frame => ({
  id: frameId(i),
  x: 100,
  y: 100,
  w: FRAME_DEFAULT_W,
  h: FRAME_DEFAULT_H,
  title: "Start",
  color: "neutral",
  ...FRAME_DEFAULTS,
  rev: 1,
  authorId: alex.id,
  ...extra,
});

describe("frame title inks", () => {
  it.each(THEMES)("every ink (auto = the frame title token) is 4.5:1 on every frame header colour in %s", (selector) => {
    const c = theme(selector);
    for (const ink of NOTE_TEXT_COLORS) {
      const name = frameInkToken(ink).replace(/^--sy-/, "");
      const fg = c[name];
      expect(fg, `${name} in ${selector}`).toMatch(/^#[0-9a-f]{6}$/);
      for (const key of FRAME_COLORS) {
        expect(contrast(fg!, c[`frame-${key}-header`]!), `${ink} on ${key} header`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("auto keeps the frame title token; the six inks are frame-only tokens", () => {
    expect(frameInkToken("auto")).toBe("--sy-frame-title");
    for (const ink of NOTE_TEXT_COLORS.filter((k) => k !== "auto")) expect(frameInkToken(ink)).toBe(`--sy-frame-text-${ink}`);
  });

  it("in light, each frame ink is the note ink's value; in dark, frames get their own (light) inks", () => {
    const light = theme(THEMES[0]);
    const dark = theme(THEMES[1]);
    for (const ink of NOTE_TEXT_COLORS.filter((k) => k !== "auto")) {
      expect(light[`frame-text-${ink}`], ink).toBe(light[textColorToken(ink).replace(/^--sy-/, "")]);
      expect(luminance(dark[`frame-text-${ink}`]!), ink).toBeGreaterThan(luminance(dark["frame-neutral-header"]!));
    }
  });

  it("swatches and the header use var() references only, so they show the current theme's value", () => {
    for (const ink of NOTE_TEXT_COLORS) {
      expect(FRAME_INK_SWATCHES[ink]).toEqual({ backgroundColor: `var(${frameInkToken(ink)})` });
      const header = frameHeaderStyle(frame(0, { titleTextColor: ink, color: "blue" }));
      expect(header).toEqual({ backgroundColor: "var(--sy-frame-blue-header)", color: `var(${frameInkToken(ink)})` });
    }
  });
});

describe("frame header height", () => {
  it("follows the title size: 44px for s and m, 48 for l, 56 for xl, never below the touch minimum", () => {
    expect(NOTE_FONT_SIZES.map((k) => px(frameHeaderHeightToken(k).replace(/^--sy-/, "")))).toEqual([44, 44, 48, 56]);
    for (const k of NOTE_FONT_SIZES) expect(px(frameHeaderHeightToken(k).replace(/^--sy-/, ""))).toBeGreaterThanOrEqual(px("touch-min"));
    // The default (v9's) header height is still 44px.
    expect(px("frame-header-h")).toBe(44);
  });

  it("the largest header plus the bottom edge strip fits a frame at its minimum height, with body left over", () => {
    const body = FRAME_MIN_H - px("frame-header-xl") - px("frame-edge");
    expect(FRAME_MIN_H).toBe(160);
    expect(body).toBe(92);
    expect(body).toBeGreaterThanOrEqual(px("touch-min"));
  });

  it("the frame's root sets the header height for its size, so the header and the side strips under it follow", () => {
    for (const k of NOTE_FONT_SIZES) {
      const style = frameRootStyle(frame(0, { titleFontSize: k })) as Record<string, string>;
      expect(style["--sy-frame-header-h"]).toBe(`var(${frameHeaderHeightToken(k)})`);
      expect(style.backgroundColor).toBe("var(--sy-frame-neutral-fill)");
      expect(JSON.stringify(style)).not.toMatch(/#[0-9a-f]{3,8}|\d+px/i);
    }
  });
});

describe("frame title classes", () => {
  it("defaults reproduce the v9 header: medium (the old text-sm size), semibold, upright, left", () => {
    expect(frameTitleClasses(frame(0))).toEqual(["text-note-m", "text-left", "font-semibold"]);
    expect(tokens).toMatch(/--sy-note-font-m:\s*0\.875rem;/);
    expect(tokens).toMatch(/--sy-text-sm:\s*0\.875rem;/);
  });

  it("bold is semibold (a little lighter than note bold), not bold is normal weight; italic, size and alignment apply", () => {
    for (const size of NOTE_FONT_SIZES) {
      for (const align of NOTE_ALIGNS) {
        const classes = frameTitleClasses(frame(0, { titleFontSize: size, titleAlign: align, titleBold: false, titleItalic: true }));
        expect(classes).toEqual([NOTE_FONT_SIZE_CLASSES[size], NOTE_ALIGN_CLASSES[align], "font-normal", "italic"]);
      }
    }
    expect(frameTitleClasses(frame(0))).not.toContain("font-bold");
  });

  it("frameTitleStyle reads the five fields as a text part style", () => {
    expect(frameTitleStyle(frame(0, { titleTextColor: "green" }))).toEqual({ fontSize: "m", bold: true, italic: false, textColor: "green", align: "left" });
  });
});

/* ── Session ─────────────────────────────────────────────────────────── */

class FakeSocket {
  sent: Record<string, unknown>[] = [];
  constructor(readonly handlers: SocketHandlers) {}
  send = (data: string) => {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  };
  close = () => {};
  receive(data: unknown) {
    this.handlers.onMessage(JSON.stringify(data));
  }
}

function session(frames: Frame[] = [frame(0)]) {
  let socket: FakeSocket | null = null;
  const views: RoomView[] = [];
  const createSocket: SocketFactory = (_url, handlers) => (socket = new FakeSocket(handlers));
  const s = new RoomSession({ url: "wss://relay.example.test/ws?room=CODE", createSocket, checkCode: () => Promise.resolve("valid"), onChange: (v) => views.push(v) });
  s.join("Alex");
  const sock = () => {
    if (!socket) throw new Error("no socket");
    return socket;
  };
  sock().handlers.onOpen();
  sock().receive({ type: "welcome", protocolVersion: PROTOCOL_VERSION });
  sock().receive({ type: "joined", you: alex, participants: [alex], locked: false, timer: null });
  sock().receive({ type: "snapshot", notes: [] });
  sock().receive({ type: "framesSnapshot", frames });
  const view = () => views.at(-1)!;
  const sent = (type: string) => sock().sent.filter((m) => m.type === type);
  return { session: s, sock, view, sent };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  useBoardUi.getState().resetRoom();
});

describe("session: frame title style", () => {
  it("is optimistic and sends only the fields that changed", () => {
    const t = session();
    expect(t.session.editFrame(frameId(0), { titleFontSize: "xl", titleBold: true, titleItalic: true })).toBe(true);
    expect(findFrame(t.view().board, frameId(0))?.frame).toMatchObject({ titleFontSize: "xl", titleBold: true, titleItalic: true });
    expect(t.sent("frameEdit")).toEqual([{ type: "frameEdit", id: frameId(0), titleFontSize: "xl", titleItalic: true }]);
  });

  it("an edit that changes nothing sends nothing", () => {
    const t = session();
    t.session.editFrame(frameId(0), { ...FRAME_DEFAULTS });
    expect(t.sent("frameEdit")).toEqual([]);
  });

  it("rolls back when refused", () => {
    const t = session();
    t.session.editFrame(frameId(0), { titleTextColor: "red", titleAlign: "right" });
    t.sock().receive({ type: "error", code: "rate_limited", message: "Slow down.", frameId: frameId(0) });
    expect(findFrame(t.view().board, frameId(0))?.frame).toMatchObject(FRAME_DEFAULTS);
  });

  it("the server's frameUpdated confirms it; a later one from someone else wins (last write wins)", () => {
    const t = session();
    t.session.editFrame(frameId(0), { titleTextColor: "red" });
    t.sock().receive({ type: "frameUpdated", frame: frame(0, { titleTextColor: "red", rev: 2 }) });
    t.sock().receive({ type: "frameUpdated", frame: frame(0, { titleTextColor: "green", rev: 3 }) });
    expect(findFrame(t.view().board, frameId(0))).toMatchObject({ frame: { titleTextColor: "green" }, confirmed: { titleTextColor: "green" } });
  });

  it("a style set before the add is confirmed goes out in one frameEdit with the title once it is", () => {
    const t = session([]);
    const id = t.session.addFrame({ x: 0, y: 0, color: "neutral" }) ?? "";
    expect(findFrame(t.view().board, id)?.frame).toMatchObject(FRAME_DEFAULTS);
    t.session.editFrame(id, { title: "Stop", titleFontSize: "l", titleAlign: "center" });
    expect(t.sent("frameEdit")).toEqual([]);
    const add = t.sent("frameAdd")[0] as { clientRef: string };
    expect(add).not.toHaveProperty("titleFontSize");
    t.sock().receive({ type: "frameAdded", frame: frame(4, { title: "" }), clientRef: add.clientRef });
    expect(t.sent("frameEdit")).toEqual([{ type: "frameEdit", id: frameId(4), title: "Stop", titleFontSize: "l", titleAlign: "center" }]);
    expect(findFrame(t.view().board, frameId(4))?.frame).toMatchObject({ title: "Stop", titleFontSize: "l", titleAlign: "center" });
  });

  it("is refused while disconnected", () => {
    const t = session();
    t.sock().handlers.onClose();
    expect(t.session.editFrame(frameId(0), { titleBold: false })).toBe(false);
    expect(t.sent("frameEdit")).toEqual([]);
  });

  it("a remote style edit never replaces a title being typed", () => {
    let board = applyFramesSnapshot(applySnapshot(EMPTY_BOARD, []), [frame(0)]);
    board = setFrameDraft(board, frameId(0), "My typing");
    board = applyFrameUpdated(board, frame(0, { titleFontSize: "xl", rev: 2 }));
    expect(findFrame(board, frameId(0))).toMatchObject({ draft: "My typing", frame: { titleFontSize: "xl" } });
  });
});
