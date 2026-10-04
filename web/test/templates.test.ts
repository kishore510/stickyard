import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BOARD_HEIGHT,
  BOARD_WIDTH,
  FRAME_COLORS,
  FRAME_DEFAULTS,
  FRAME_MAX_H,
  FRAME_MAX_W,
  FRAME_MIN_H,
  FRAME_MIN_W,
  MAX_FRAMES_PER_ROOM,
  MAX_FRAME_TITLE,
  NOTE_ALIGNS,
  NOTE_DEFAULTS,
  NOTE_FONT_SIZES,
  NOTE_TEXT_COLORS,
  PROTOCOL_VERSION,
  cleanFrameTitle,
  codePointLength,
  type Frame,
  type Note,
  type Participant,
} from "@stickyard/shared";
import type { SocketFactory, SocketHandlers } from "../src/connection/socket";
import { findFrame } from "../src/frames/board";
import { findNote } from "../src/notes/board";
import { PALETTE_CATEGORIES, paletteSections } from "../src/palette/registry";
import { NOTICES, RoomSession, TEMPLATE_MESSAGES_PER_SECOND, TEMPLATE_STEP_MS, type RoomView } from "../src/rooms/session";
import { clampTemplateOrigin, placeTemplate, templateBounds, templateOrigin } from "../src/templates/place";
import { TEMPLATES, type Template } from "../src/templates/registry";

/* Slice templates (web only): ready-made sets of frames. Generic fixtures. */

const alex: Participant = { id: "AAAAAAAAAAAAAAAA", name: "Alex", colourIndex: 0 };
const frameId = (i: number) => `frame${String(i).padStart(11, "0")}`;
const noteId = (i: number) => `note${String(i).padStart(12, "0")}`;
const frame = (i: number, extra: Partial<Frame> = {}): Frame => ({
  id: frameId(i),
  x: 0,
  y: 0,
  w: 640,
  h: 400,
  title: "",
  color: "neutral",
  ...FRAME_DEFAULTS,
  rev: 1,
  authorId: alex.id,
  ...extra,
});
const note = (i: number, x: number, y: number): Note => ({ id: noteId(i), x, y, ...NOTE_DEFAULTS, text: "Idea", color: "yellow", z: i, rev: 1, authorId: alex.id });
const overlaps = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const byId = (id: string): Template => {
  const t = TEMPLATES.find((x) => x.id === id);
  if (!t) throw new Error(`no template ${id}`);
  return t;
};

describe("template registry", () => {
  it("has the four templates, in order", () => {
    expect(TEMPLATES.map((t) => t.label)).toEqual(["Retro", "Start Stop Continue", "2x2 Impact and Effort", "Sprint planning"]);
    expect(new Set(TEMPLATES.map((t) => t.id)).size).toBe(TEMPLATES.length);
  });

  it.each(TEMPLATES.map((t) => [t.label, t] as const))("%s validates against the shared constants", (_label, t) => {
    expect(t.frames.length).toBeGreaterThan(0);
    expect(t.frames.length).toBeLessThanOrEqual(MAX_FRAMES_PER_ROOM);
    for (const f of t.frames) {
      // Titles: within the cap, and already clean (the normal frame path cleans them again).
      expect(codePointLength(f.title), f.title).toBeLessThanOrEqual(MAX_FRAME_TITLE);
      expect(cleanFrameTitle(f.title)).toBe(f.title);
      expect(f.title.length).toBeGreaterThan(0);
      expect(FRAME_COLORS).toContain(f.color);
      expect(NOTE_FONT_SIZES).toContain(f.style.titleFontSize);
      expect(NOTE_TEXT_COLORS).toContain(f.style.titleTextColor);
      expect(NOTE_ALIGNS).toContain(f.style.titleAlign);
      expect(typeof f.style.titleBold).toBe("boolean");
      expect(typeof f.style.titleItalic).toBe("boolean");
      expect(Object.keys(f.style).sort()).toEqual(Object.keys(FRAME_DEFAULTS).sort());
      expect(f.w).toBeGreaterThanOrEqual(FRAME_MIN_W);
      expect(f.w).toBeLessThanOrEqual(FRAME_MAX_W);
      expect(f.h).toBeGreaterThanOrEqual(FRAME_MIN_H);
      expect(f.h).toBeLessThanOrEqual(FRAME_MAX_H);
      expect(Number.isInteger(f.x) && Number.isInteger(f.y) && Number.isInteger(f.w) && Number.isInteger(f.h)).toBe(true);
    }
    // Template units start at 0, 0 and the whole template fits on the board.
    expect(Math.min(...t.frames.map((f) => f.x))).toBe(0);
    expect(Math.min(...t.frames.map((f) => f.y))).toBe(0);
    const { width, height } = templateBounds(t);
    expect(width).toBeLessThanOrEqual(BOARD_WIDTH);
    expect(height).toBeLessThanOrEqual(BOARD_HEIGHT);
    for (const [i, a] of t.frames.entries()) for (const b of t.frames.slice(i + 1)) expect(overlaps(a, b), `${a.title} / ${b.title}`).toBe(false);
  });

  it("uses a different colour per column where it helps, and a styled (bold, centred, larger) title", () => {
    for (const t of TEMPLATES) {
      expect(new Set(t.frames.map((f) => f.color)).size, t.label).toBe(t.frames.length);
      for (const f of t.frames) expect(f.style).toMatchObject({ titleBold: true, titleAlign: "center" });
      expect(t.frames.some((f) => f.style.titleFontSize === "l" || f.style.titleFontSize === "xl"), t.label).toBe(true);
    }
  });

  it("has the suggested titles", () => {
    expect(byId("retro").frames.map((f) => f.title)).toEqual(["Went well", "Didn't go well", "Actions"]);
    expect(byId("start-stop-continue").frames.map((f) => f.title)).toEqual(["Start", "Stop", "Continue"]);
    expect(byId("impact-effort").frames.map((f) => f.title)).toEqual([
      "Quick wins: high impact, low effort",
      "Major projects: high impact, high effort",
      "Fill-ins: low impact, low effort",
      "Thankless tasks: low impact, high effort",
    ]);
    expect(byId("sprint-planning").frames.map((f) => f.title)).toEqual(["Sprint goal", "Candidates", "Committed", "Risks and questions"]);
  });
});

describe("placing a template", () => {
  const retro = byId("retro");
  const { width, height } = templateBounds(retro);

  it("a click centres its bounding box on the viewport centre", () => {
    expect(templateOrigin(retro, { x: 1600, y: 1000 })).toEqual({ x: 1600 - width / 2, y: 1000 - height / 2 });
  });

  it.each([
    ["top-left corner", { x: 0, y: 0 }],
    ["bottom-right corner", { x: BOARD_WIDTH, y: BOARD_HEIGHT }],
    ["far off the board", { x: -5000, y: 99999 }],
  ])("is clamped so every frame is on the board (click near the %s)", (_label, centre) => {
    const placed = placeTemplate(retro, templateOrigin(retro, centre));
    for (const f of placed) {
      expect(f.x).toBeGreaterThanOrEqual(0);
      expect(f.y).toBeGreaterThanOrEqual(0);
      expect(f.x + f.w).toBeLessThanOrEqual(BOARD_WIDTH);
      expect(f.y + f.h).toBeLessThanOrEqual(BOARD_HEIGHT);
    }
  });

  it("a drop's top-left is clamped the same way, and keeps the frames' arrangement", () => {
    const origin = clampTemplateOrigin(retro, { x: BOARD_WIDTH - 10, y: -40 });
    expect(origin).toEqual({ x: BOARD_WIDTH - width, y: 0 });
    const placed = placeTemplate(retro, origin);
    expect(placed.map((f) => [f.x - origin.x, f.y - origin.y, f.w, f.h])).toEqual(retro.frames.map((f) => [f.x, f.y, f.w, f.h]));
  });

  it("carries title, colour and style through", () => {
    const placed = placeTemplate(retro, { x: 100, y: 100 });
    expect(placed[0]).toMatchObject({ title: "Went well", color: retro.frames[0]!.color, style: retro.frames[0]!.style });
  });
});

/* ── Session: applying ─────────────────────────────────────────────── */

class FakeSocket {
  sent: { at: number; message: Record<string, unknown> }[] = [];
  constructor(readonly handlers: SocketHandlers) {}
  send = (data: string) => {
    this.sent.push({ at: Date.now(), message: JSON.parse(data) as Record<string, unknown> });
  };
  close = () => {};
  receive(data: unknown) {
    this.handlers.onMessage(JSON.stringify(data));
  }
}

function session({ frames = [] as Frame[], notes = [] as Note[] } = {}) {
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
  sock().receive({ type: "joined", you: alex, participants: [alex] });
  sock().receive({ type: "snapshot", notes });
  sock().receive({ type: "framesSnapshot", frames });
  const view = () => views.at(-1)!;
  const start = sock().sent.length;
  /** Messages the template sent (after joining). */
  const out = () => sock().sent.slice(start);
  const types = () => out().map((m) => m.message.type);
  /** Confirms every frameAdd sent so far that isn't confirmed yet, as server ids 100, 101, ... */
  let next = 100;
  const confirmed = new Set<string>();
  const confirmAdds = () => {
    for (const { message } of out()) {
      if (message.type !== "frameAdd" || confirmed.has(message.clientRef as string)) continue;
      confirmed.add(message.clientRef as string);
      const id = frameId(next++);
      sock().receive({
        type: "frameAdded",
        frame: frame(Number(id.slice(5)), { x: message.x as number, y: message.y as number, title: message.title as string, color: message.color as Frame["color"] }),
        clientRef: message.clientRef,
      });
    }
  };
  return { session: s, sock, view, out, types, confirmAdds };
}

/** Runs the template to the end: confirms adds as they're sent, step by step. */
async function runAll(t: ReturnType<typeof session>) {
  for (let i = 0; i < 40; i++) {
    t.confirmAdds();
    await vi.advanceTimersByTimeAsync(TEMPLATE_STEP_MS);
  }
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("session: applying a template", () => {
  const retro = byId("retro");
  const plan = placeTemplate(retro, { x: 200, y: 200 });

  it("adds each frame (position, colour, title), and only after the server confirms it, one resize and one style edit", async () => {
    const t = session();
    expect(t.session.applyTemplate(plan)).toBe(true);
    expect(t.view().template).toMatchObject({ state: "applying" });
    // Nothing but adds until a confirmation arrives.
    await vi.advanceTimersByTimeAsync(TEMPLATE_STEP_MS * 10);
    expect(t.types()).toEqual(["frameAdd", "frameAdd", "frameAdd"]);
    expect(t.out().map((m) => m.message)).toEqual(
      plan.map((f) => ({ type: "frameAdd", clientRef: expect.any(String), x: expect.any(Number), y: f.y, color: f.color, title: f.title })),
    );
    await runAll(t);
    expect(t.types()).toEqual(["frameAdd", "frameAdd", "frameAdd", "frameResize", "frameEdit", "frameResize", "frameEdit", "frameResize", "frameEdit"]);
    const resizes = t.out().filter((m) => m.message.type === "frameResize").map((m) => m.message);
    expect(resizes).toEqual(plan.map((f, i) => ({ type: "frameResize", id: frameId(100 + i), x: f.x, y: f.y, w: f.w, h: f.h, final: true })));
    const edits = t.out().filter((m) => m.message.type === "frameEdit").map((m) => m.message);
    expect(edits[0]).toEqual({ type: "frameEdit", id: frameId(100), titleFontSize: retro.frames[0]!.style.titleFontSize, titleAlign: "center" });
    expect(t.view().template).toMatchObject({ state: "done", frameIds: [frameId(100), frameId(101), frameId(102)] });
    for (const [i, f] of plan.entries()) expect(findFrame(t.view().board, frameId(100 + i))?.frame).toMatchObject({ x: f.x, y: f.y, w: f.w, h: f.h, title: f.title, ...f.style });
  });

  it(`pacing: never more than ${TEMPLATE_MESSAGES_PER_SECOND} template messages in any second, well under the relay's 30 a second`, async () => {
    expect(TEMPLATE_MESSAGES_PER_SECOND).toBeLessThanOrEqual(10);
    expect(TEMPLATE_STEP_MS).toBe(1000 / TEMPLATE_MESSAGES_PER_SECOND);
    const t = session();
    t.session.applyTemplate(placeTemplate(byId("sprint-planning"), { x: 0, y: 0 }));
    await runAll(t);
    const times = t.out().map((m) => m.at);
    expect(times).toHaveLength(12);
    for (const at of times) expect(times.filter((x) => x >= at && x < at + 1000).length).toBeLessThanOrEqual(TEMPLATE_MESSAGES_PER_SECOND);
  });

  it("never moves, resizes or deletes existing frames and notes", async () => {
    const existing = frame(1, { x: 300, y: 300, title: "Mine" });
    const t = session({ frames: [existing], notes: [note(0, 400, 400)] });
    t.session.applyTemplate(plan);
    await runAll(t);
    const touched = t.out().map((m) => m.message).filter((m) => m.id === existing.id || m.id === noteId(0) || m.type === "noteBatch" || m.type === "noteMove");
    expect(touched).toEqual([]);
    expect(findFrame(t.view().board, existing.id)?.frame).toEqual(existing);
    expect(findNote(t.view().board, noteId(0))?.note).toMatchObject({ x: 400, y: 400 });
  });

  it("refuses with nothing sent when the board hasn't enough free frame slots, and says how many it needs and has", () => {
    const t = session({ frames: Array.from({ length: MAX_FRAMES_PER_ROOM - 2 }, (_, i) => frame(i)) });
    expect(t.session.applyTemplate(plan)).toBe(false);
    expect(t.out()).toEqual([]);
    expect(t.view().noteNotice).toBe(NOTICES.templateNoRoom(3, 2));
    expect(NOTICES.templateNoRoom(3, 2)).toBe("This template needs 3 frames, but the board has room for 2 more.");
    expect(t.view().template).toBeNull();
  });

  it("a refusal part-way: one notice, frames already made stay, the rest isn't sent, no retry", async () => {
    const t = session();
    t.session.applyTemplate(plan);
    await vi.advanceTimersByTimeAsync(TEMPLATE_STEP_MS * 3);
    const adds = t.out().map((m) => m.message);
    // The first is confirmed; the second is refused (someone else filled the board meanwhile).
    t.sock().receive({ type: "frameAdded", frame: frame(100, { x: adds[0]!.x as number, y: adds[0]!.y as number, title: adds[0]!.title as string, color: adds[0]!.color as Frame["color"] }), clientRef: adds[0]!.clientRef });
    t.sock().receive({ type: "error", code: "frames_full", message: "Full.", clientRef: adds[1]!.clientRef });
    await vi.advanceTimersByTimeAsync(TEMPLATE_STEP_MS * 30);
    expect(t.view().noteNotice).toBe(NOTICES.templatePartial);
    expect(t.view().template).toMatchObject({ state: "partial" });
    expect(findFrame(t.view().board, frameId(100))).toBeDefined();
    const sentAfter = t.out().slice(3).map((m) => m.message.type);
    expect(sentAfter).toEqual([]);
    // The third add was already out: when it's confirmed it stays, and nothing more is sent.
    t.sock().receive({ type: "frameAdded", frame: frame(102, { x: adds[2]!.x as number, y: adds[2]!.y as number, title: adds[2]!.title as string, color: adds[2]!.color as Frame["color"] }), clientRef: adds[2]!.clientRef });
    await vi.advanceTimersByTimeAsync(TEMPLATE_STEP_MS * 30);
    expect(findFrame(t.view().board, frameId(102))).toBeDefined();
    expect(t.out().slice(3)).toEqual([]);
    expect(t.view().noteNotice).toBe(NOTICES.templatePartial);
  });

  it("a refused resize or edit also ends it as partly applied (frames stay)", async () => {
    const t = session();
    t.session.applyTemplate(plan);
    for (let i = 0; i < 5; i++) {
      t.confirmAdds();
      await vi.advanceTimersByTimeAsync(TEMPLATE_STEP_MS);
    }
    const resize = t.out().find((m) => m.message.type === "frameResize")?.message;
    expect(resize).toBeDefined();
    t.sock().receive({ type: "error", code: "rate_limited", message: "Slow down.", frameId: resize!.id });
    const count = t.out().length;
    await vi.advanceTimersByTimeAsync(TEMPLATE_STEP_MS * 30);
    expect(t.out()).toHaveLength(count);
    expect(t.view().noteNotice).toBe(NOTICES.templatePartial);
    expect(t.view().board.frames).toHaveLength(3);
  });

  it("can't be applied twice at once", async () => {
    const t = session();
    expect(t.session.applyTemplate(plan)).toBe(true);
    expect(t.session.applyTemplate(plan)).toBe(false);
    await runAll(t);
    expect(t.out().filter((m) => m.message.type === "frameAdd")).toHaveLength(3);
    // Once it's done, another may be applied.
    expect(t.session.applyTemplate(placeTemplate(byId("start-stop-continue"), { x: 0, y: 1000 }))).toBe(true);
  });

  it("is refused while disconnected; a disconnect part-way ends it as partly applied", async () => {
    const t = session();
    t.sock().handlers.onClose();
    expect(t.session.applyTemplate(plan)).toBe(false);
    const u = session();
    u.session.applyTemplate(plan);
    await vi.advanceTimersByTimeAsync(TEMPLATE_STEP_MS);
    u.sock().handlers.onClose();
    const count = u.out().length;
    await vi.advanceTimersByTimeAsync(TEMPLATE_STEP_MS * 30);
    expect(u.out()).toHaveLength(count);
    expect(u.view().template).toMatchObject({ state: "partial" });
  });
});

describe("palette: Templates", () => {
  const state = { live: true, noteCount: 0 };
  const ctx = { noteReason: null, frameReason: null, templateReason: null };

  it("is a Templates category on the panel (md and up) only, one tile per template", () => {
    const panel = paletteSections(PALETTE_CATEGORIES, "add", state, "", "panel");
    const drawer = paletteSections(PALETTE_CATEGORIES, "add", state, "", "drawer");
    expect(panel.map((s) => s.category.label)).toEqual(["Notes", "Frames", "Templates"]);
    expect(panel.find((s) => s.category.id === "templates")?.items.map((i) => i.label)).toEqual(TEMPLATES.map((t) => t.label));
    expect(drawer.map((s) => s.category.id)).not.toContain("templates");
  });

  it.each([
    ["retro", ["Retro", "Start Stop Continue"]],
    ["kanban", ["Sprint planning"]],
    ["matrix", ["2x2 Impact and Effort"]],
    ["impact", ["2x2 Impact and Effort"]],
    ["sprint goal", ["Sprint planning"]],
  ])("search %s finds %j", (query, labels) => {
    const found = paletteSections(PALETTE_CATEGORIES, "add", state, query, "panel").find((s) => s.category.id === "templates");
    expect(found?.items.map((i) => i.label)).toEqual(labels);
  });

  it("each tile applies its template through plain actions, drops at its own size, and is off with the template reason", () => {
    const items = PALETTE_CATEGORIES.find((c) => c.id === "templates")?.items ?? [];
    const applyTemplate = vi.fn();
    items[0]?.create({ addNote: vi.fn(), addFrame: vi.fn(), applyTemplate }, { x: 10, y: 20 });
    expect(applyTemplate).toHaveBeenCalledWith(TEMPLATES[0], { x: 10, y: 20 });
    const { width, height } = templateBounds(TEMPLATES[0]!);
    expect(items[0]?.dropSize).toEqual({ width, height });
    expect(items[0]?.preview).toEqual({ kind: "template", template: TEMPLATES[0] });
    expect(items[0]?.disabled(ctx)).toBeNull();
    expect(items[0]?.disabled({ ...ctx, templateReason: "Busy" })).toBe("Busy");
  });
});

describe("fitting to a new template", () => {
  it("is animated with the base duration, which reduced motion sets to 0", async () => {
    const { readFileSync } = await import("node:fs");
    const tokens = readFileSync(new URL("../src/styles/tokens.css", import.meta.url), "utf8");
    const reduced = tokens.slice(tokens.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced.slice(0, reduced.indexOf("}\n}"))).toMatch(/--sy-duration-base:\s*0ms;/);
    const view = readFileSync(new URL("../src/canvas/useCanvasView.ts", import.meta.url), "utf8");
    expect(view).toMatch(/readPxToken\("--sy-duration-base"/);
    // The board fits to the new frames with the animated fit (not an instant jump).
    const board = readFileSync(new URL("../src/canvas/RoomBoard.tsx", import.meta.url), "utf8");
    expect(board).toMatch(/const frames = templateFrames\(/);
    expect(board).toMatch(/canvas\.fit\(frames\);/);
  });
});
