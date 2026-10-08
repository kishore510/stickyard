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
  MAX_MESSAGE_BYTES,
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
import { ITEMS_STEP_MS, NOTICES, RoomSession, type RoomView } from "../src/rooms/session";
import { clampTemplateOrigin, placeTemplate, templateBounds, templateOrigin } from "../src/templates/place";
import { TEMPLATE_GROUPS, TEMPLATES, type Template } from "../src/templates/registry";

/* Slice templates (web only): ready-made sets of frames. Generic fixtures. */

const alex: Participant = { id: "AAAAAAAAAAAAAAAA", name: "Alex", colourIndex: 0, host: false };
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
  it("has the fourteen templates, in group order, with unique ids and names", () => {
    expect(TEMPLATES.map((t) => t.label)).toEqual([
      "Retro",
      "Start Stop Continue",
      "Mad Sad Glad",
      "4Ls",
      "Starfish",
      "Sailboat",
      "Sprint planning",
      "2x2 Impact and Effort",
      "Lean coffee",
      "SWOT",
      "TIME",
      "Migration strategy",
      "Technology radar",
      "RAID",
      "Architecture decision",
    ]);
    expect(new Set(TEMPLATES.map((t) => t.id)).size).toBe(TEMPLATES.length);
    expect(new Set(TEMPLATES.map((t) => t.label.toLowerCase())).size).toBe(TEMPLATES.length);
  });

  it("every template has a group from the allowed list, and the groups come in the stated order", () => {
    expect(TEMPLATE_GROUPS.map((g) => g.label)).toEqual(["Retros", "Planning and facilitation", "Architecture and analysis"]);
    const allowed = TEMPLATE_GROUPS.map((g) => g.label);
    for (const t of TEMPLATES) {
      expect(t.group, t.label).toBeDefined();
      expect(allowed, t.label).toContain(t.group);
    }
    // Registry order runs group by group: each group's entries together, groups in the stated order.
    const order = TEMPLATES.map((t) => allowed.indexOf(t.group));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(new Set(order).size).toBe(allowed.length);
    const members = (group: string) => TEMPLATES.filter((t) => t.group === group).map((t) => t.label);
    expect(members("Retros")).toEqual(["Retro", "Start Stop Continue", "Mad Sad Glad", "4Ls", "Starfish", "Sailboat"]);
    expect(members("Planning and facilitation")).toEqual(["Sprint planning", "2x2 Impact and Effort", "Lean coffee"]);
    expect(members("Architecture and analysis")).toEqual(["SWOT", "TIME", "Migration strategy", "Technology radar", "RAID", "Architecture decision"]);
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
    expect(byId("mad-sad-glad").frames.map((f) => f.title)).toEqual(["Mad", "Sad", "Glad"]);
    expect(byId("four-ls").frames.map((f) => f.title)).toEqual(["Liked", "Learned", "Lacked", "Longed for"]);
    expect(byId("starfish").frames.map((f) => f.title)).toEqual(["Keep", "Less of", "More of", "Start", "Stop"]);
    expect(byId("sailboat").frames.map((f) => f.title)).toEqual(["Goal", "Wind (helps us)", "Anchors (slow us)", "Rocks (risks)"]);
    expect(byId("lean-coffee").frames.map((f) => f.title)).toEqual(["To discuss", "Discussing", "Discussed"]);
    expect(byId("swot").frames.map((f) => f.title)).toEqual([
      "Strengths: internal, helpful",
      "Weaknesses: internal, harmful",
      "Opportunities: external, helpful",
      "Threats: external, harmful",
    ]);
    expect(byId("time").frames.map((f) => f.title)).toEqual([
      "Migrate: high value, poor fit",
      "Invest: high value, good fit",
      "Eliminate: low value, poor fit",
      "Tolerate: low value, good fit",
    ]);
    expect(byId("migration-strategy").frames.map((f) => f.title.split(":")[0])).toEqual(["Rehost", "Replatform", "Refactor", "Repurchase", "Retire", "Retain"]);
    expect(byId("tech-radar").frames.map((f) => f.title)).toEqual(["Adopt", "Trial", "Assess", "Hold"]);
    expect(byId("raid").frames.map((f) => f.title)).toEqual(["Risks", "Assumptions", "Issues", "Dependencies"]);
    expect(byId("architecture-decision").frames.map((f) => f.title)).toEqual(["Context", "Options", "Decision", "Consequences"]);
  });

  /** A frame's place in a template: its row and column, by distinct top and left edges. */
  const grid = (t: Template, title: string) => {
    const f = t.frames.find((x) => x.title.startsWith(title));
    if (!f) throw new Error(`no frame ${title}`);
    const ys = [...new Set(t.frames.map((x) => x.y))].sort((a, b) => a - b);
    const xs = [...new Set(t.frames.map((x) => x.x))].sort((a, b) => a - b);
    return { row: ys.indexOf(f.y), col: xs.indexOf(f.x), frame: f };
  };

  it("lays out the shaped templates as asked: 2 x 2, 3 x 2, 3 + 2 and a wide goal over a row", () => {
    // TIME: business value up, technical fit to the right.
    const time = byId("time");
    expect(grid(time, "Migrate")).toMatchObject({ row: 0, col: 0 });
    expect(grid(time, "Invest")).toMatchObject({ row: 0, col: 1 });
    expect(grid(time, "Eliminate")).toMatchObject({ row: 1, col: 0 });
    expect(grid(time, "Tolerate")).toMatchObject({ row: 1, col: 1 });
    const swot = byId("swot");
    expect(["Strengths", "Weaknesses", "Opportunities", "Threats"].map((n) => [grid(swot, n).row, grid(swot, n).col])).toEqual([[0, 0], [0, 1], [1, 0], [1, 1]]);
    const migration = byId("migration-strategy");
    expect(new Set(migration.frames.map((f) => f.y)).size).toBe(2);
    expect(new Set(migration.frames.map((f) => f.x)).size).toBe(3);
    // Starfish: three on top, two below, the two centred under the three.
    const starfish = byId("starfish");
    const rows = [...new Set(starfish.frames.map((f) => f.y))].map((y) => starfish.frames.filter((f) => f.y === y).length);
    expect(rows).toEqual([3, 2]);
    const { width } = templateBounds(starfish);
    const bottom = starfish.frames.filter((f) => f.y > 0);
    expect(Math.min(...bottom.map((f) => f.x)) + Math.max(...bottom.map((f) => f.x + f.w))).toBe(width);
    // Sailboat: the goal spans the row below it.
    const sailboat = byId("sailboat");
    const goal = sailboat.frames[0]!;
    expect(goal.w).toBe(templateBounds(sailboat).width);
    expect(sailboat.frames.slice(1).every((f) => f.y > goal.y + goal.h && f.y === sailboat.frames[1]!.y)).toBe(true);
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

  it.each(TEMPLATES.map((t) => [t.label, t] as const))("%s: every frame is inside the board after clamping, wherever it's placed", (_label, t) => {
    const points = [
      { x: 0, y: 0 },
      { x: BOARD_WIDTH, y: BOARD_HEIGHT },
      { x: BOARD_WIDTH, y: 0 },
      { x: -5000, y: 99999 },
      { x: BOARD_WIDTH / 2, y: BOARD_HEIGHT / 2 },
    ];
    for (const p of points) {
      for (const placed of [placeTemplate(t, templateOrigin(t, p)), placeTemplate(t, p)]) {
        for (const f of placed) {
          expect(f.x).toBeGreaterThanOrEqual(0);
          expect(f.y).toBeGreaterThanOrEqual(0);
          expect(f.x + f.w).toBeLessThanOrEqual(BOARD_WIDTH);
          expect(f.y + f.h).toBeLessThanOrEqual(BOARD_HEIGHT);
        }
        for (const [i, a] of placed.entries()) for (const b of placed.slice(i + 1)) expect(overlaps(a, b)).toBe(false);
      }
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

function session({ frames = [] as Frame[], notes = [] as Note[], silent = { active: false, count: 0 } } = {}) {
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
  sock().receive({ type: "joined", you: alex, participants: [alex], locked: false, timer: null, voting: { state: "off", budget: 5, round: 0 }, silent });
  sock().receive({ type: "snapshot", notes });
  sock().receive({ type: "framesSnapshot", frames });
  if (silent.active) sock().receive({ type: "silentMine", ids: [] });
  const view = () => views.at(-1)!;
  const start = sock().sent.length;
  /** Messages the template sent (after joining). */
  const out = () => sock().sent.slice(start);
  const types = () => out().map((m) => m.message.type);
  /** Confirms every itemsAdd sent so far that isn't answered yet: each frame gets server id 100, 101, ... */
  let next = 100;
  const answered = new Set<string>();
  const confirmAdds = () => {
    for (const { message } of out()) {
      if (message.type !== "itemsAdd" || answered.has(message.clientRef as string)) continue;
      answered.add(message.clientRef as string);
      const frames = (message.frames as (Omit<Frame, "id" | "rev" | "authorId"> & { ref: string })[]).map(({ ref, ...f }) => ({ ref, frame: frame(next++, f) }));
      sock().receive({ type: "itemsAdded", clientRef: message.clientRef, notes: [], frames, refused: [] });
    }
  };
  return { session: s, sock, view, out, types, confirmAdds };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("session: applying a template", () => {
  const retro = byId("retro");
  const plan = placeTemplate(retro, { x: 200, y: 200 });

  it("sends every frame with its place, size, title, colour and title style in one itemsAdd: no resizes, no edits, no settling", async () => {
    const t = session();
    expect(t.session.applyTemplate(plan)).toBe(true);
    expect(t.view().template).toMatchObject({ state: "applying" });
    expect(t.types()).toEqual(["itemsAdd"]);
    const sent = t.out()[0]!.message;
    expect(sent.notes).toBeUndefined();
    expect(sent.frames).toEqual(plan.map((f) => ({ ref: expect.any(String), x: f.x, y: f.y, w: f.w, h: f.h, title: f.title, color: f.color, ...f.style })));
    // Shown at once, at full size and style, before the relay answers.
    expect(t.view().board.frames.map((f) => ({ ...f.frame, id: "", authorId: "" }))).toEqual(
      plan.map((f) => ({ id: "", x: f.x, y: f.y, w: f.w, h: f.h, title: f.title, color: f.color, ...f.style, rev: 1, authorId: "" })),
    );
    t.confirmAdds();
    expect(t.view().template).toMatchObject({ state: "done", frameIds: [frameId(100), frameId(101), frameId(102)] });
    await vi.advanceTimersByTimeAsync(ITEMS_STEP_MS * 30);
    expect(t.types()).toEqual(["itemsAdd"]);
    for (const [i, f] of plan.entries()) expect(findFrame(t.view().board, frameId(100 + i))?.frame).toMatchObject({ x: f.x, y: f.y, w: f.w, h: f.h, title: f.title, ...f.style });
  });

  it("every template fits in one message, under the 4 KiB cap, the largest included", () => {
    for (const template of TEMPLATES) {
      const t = session();
      // The far corner gives every coordinate its most digits.
      expect(t.session.applyTemplate(placeTemplate(template, { x: BOARD_WIDTH, y: BOARD_HEIGHT })), template.label).toBe(true);
      expect(t.types(), template.label).toEqual(["itemsAdd"]);
      const bytes = new TextEncoder().encode(JSON.stringify(t.out()[0]!.message)).length;
      expect(bytes, template.label).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
      expect((t.out()[0]!.message.frames as unknown[]).length).toBe(template.frames.length);
    }
    const largest = Math.max(...TEMPLATES.map((t) => t.frames.length));
    expect(largest).toBe(6);
    expect(largest).toBeLessThanOrEqual(MAX_FRAMES_PER_ROOM);
  });

  it("the largest template passes the free-slots check on an empty board, and is refused with the same message when one slot short", () => {
    const largest = TEMPLATES.reduce((a, b) => (b.frames.length > a.frames.length ? b : a));
    const plan6 = placeTemplate(largest, { x: 0, y: 0 });
    expect(session().session.applyTemplate(plan6)).toBe(true);
    const fits = session({ frames: Array.from({ length: MAX_FRAMES_PER_ROOM - largest.frames.length }, (_, i) => frame(i)) });
    expect(fits.session.applyTemplate(plan6)).toBe(true);
    const short = session({ frames: Array.from({ length: MAX_FRAMES_PER_ROOM - largest.frames.length + 1 }, (_, i) => frame(i)) });
    expect(short.session.applyTemplate(plan6)).toBe(false);
    expect(short.view().noteNotice).toBe(NOTICES.templateNoRoom(largest.frames.length, largest.frames.length - 1));
    expect(short.out()).toEqual([]);
  });

  it("still applies during a silent round (frames only, so nothing is sealed)", () => {
    const t = session({ silent: { active: true, count: 2 } });
    expect(t.view().silent).toEqual({ active: true, count: 2 });
    const sailboat = placeTemplate(byId("sailboat"), { x: 100, y: 100 });
    expect(t.session.applyTemplate(sailboat)).toBe(true);
    expect(t.types()).toEqual(["itemsAdd"]);
    expect(t.out()[0]!.message.notes).toBeUndefined();
    t.confirmAdds();
    expect(t.view().template).toMatchObject({ state: "done" });
    expect(t.view().board.frames).toHaveLength(sailboat.length);
  });

  it("never moves, resizes or deletes existing frames and notes", async () => {
    const existing = frame(1, { x: 300, y: 300, title: "Mine" });
    const t = session({ frames: [existing], notes: [note(0, 400, 400)] });
    t.session.applyTemplate(plan);
    t.confirmAdds();
    await vi.advanceTimersByTimeAsync(ITEMS_STEP_MS * 10);
    expect(t.types()).toEqual(["itemsAdd"]);
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

  it("a refusal part-way (someone else filled the board): one notice, the frames made stay, the refused ones go, no retry", async () => {
    const t = session();
    t.session.applyTemplate(plan);
    const sent = t.out()[0]!.message;
    const items = sent.frames as { ref: string }[];
    const made = { ref: items[0]!.ref, frame: frame(100, { ...plan[0]!, ...plan[0]!.style }) };
    t.sock().receive({
      type: "itemsAdded",
      clientRef: sent.clientRef,
      notes: [],
      frames: [made],
      refused: [
        { kind: "frame", index: 1, ref: items[1]!.ref, reason: "frames_full" },
        { kind: "frame", index: 2, ref: items[2]!.ref, reason: "frames_full" },
      ],
    });
    expect(t.view().noteNotice).toBe(NOTICES.templatePartial);
    expect(t.view().template).toMatchObject({ state: "partial", frameIds: [frameId(100)] });
    expect(t.view().board.frames.map((f) => f.frame.id)).toEqual([frameId(100)]);
    await vi.advanceTimersByTimeAsync(ITEMS_STEP_MS * 30);
    expect(t.types()).toEqual(["itemsAdd"]);
  });

  it("a whole refusal (rate limited) ends it as partly applied, with nothing made", () => {
    const t = session();
    t.session.applyTemplate(plan);
    t.sock().receive({ type: "error", code: "rate_limited", message: "Slow down.", clientRef: t.out()[0]!.message.clientRef });
    expect(t.view().template).toMatchObject({ state: "partial", frameIds: [] });
    expect(t.view().noteNotice).toBe(NOTICES.templatePartial);
    expect(t.view().board.frames).toEqual([]);
  });

  it("can't be applied twice at once", () => {
    const t = session();
    expect(t.session.applyTemplate(plan)).toBe(true);
    expect(t.session.applyTemplate(plan)).toBe(false);
    t.confirmAdds();
    expect(t.out().filter((m) => m.message.type === "itemsAdd")).toHaveLength(1);
    // Once it's done, another may be applied.
    expect(t.session.applyTemplate(placeTemplate(byId("start-stop-continue"), { x: 0, y: 1000 }))).toBe(true);
  });

  it("is refused while disconnected; a disconnect part-way ends it as partly applied, and the frames not confirmed are discarded (since reconnect)", async () => {
    const t = session();
    t.sock().handlers.onClose();
    expect(t.session.applyTemplate(plan)).toBe(false);
    const u = session();
    u.session.applyTemplate(plan);
    const dropped = u.sock();
    dropped.handlers.onClose();
    const count = dropped.sent.length;
    await vi.advanceTimersByTimeAsync(ITEMS_STEP_MS * 30);
    expect(dropped.sent).toHaveLength(count);
    if (u.sock() !== dropped) expect(u.sock().sent).toEqual([]);
    expect(u.view().template).toMatchObject({ state: "partial", frameIds: [] });
    // No offline queue: the board shows what the relay confirmed (none of them yet).
    expect(u.view().board.frames).toHaveLength(0);
  });
});

describe("palette: Templates", () => {
  const state = { live: true, noteCount: 0, isHost: false };
  const ctx = { noteReason: null, frameReason: null, templateReason: null, timerReason: null, shapeReason: null };
  const groupIds = TEMPLATE_GROUPS.map((g) => g.categoryId);
  const templateSections = (query: string) => paletteSections(PALETTE_CATEGORIES, "add", state, query, "panel").filter((s) => groupIds.includes(s.category.id));
  const templateItems = PALETTE_CATEGORIES.filter((c) => groupIds.includes(c.id)).flatMap((c) => c.items);

  it("is one category per template group on the panel (md and up) only, headed by the group's name, entries in registry order", () => {
    const panel = paletteSections(PALETTE_CATEGORIES, "add", state, "", "panel");
    const drawer = paletteSections(PALETTE_CATEGORIES, "add", state, "", "drawer");
    expect(panel.map((s) => s.category.label)).toEqual(["Notes", "Frames", "Shapes", "Retros", "Planning and facilitation", "Architecture and analysis"]);
    for (const group of TEMPLATE_GROUPS) {
      expect(panel.find((s) => s.category.id === group.categoryId)?.items.map((i) => i.label)).toEqual(TEMPLATES.filter((t) => t.group === group.label).map((t) => t.label));
    }
    expect(templateItems.map((i) => i.label)).toEqual(TEMPLATES.map((t) => t.label));
    for (const id of groupIds) expect(drawer.map((s) => s.category.id)).not.toContain(id);
  });

  it.each([
    ["template", [["Retros", 6], ["Planning and facilitation", 3], ["Architecture and analysis", 6]]],
    ["retro", [["Retros", 6]]],
    ["kanban", [["Planning and facilitation", 2]]],
    ["matrix", [["Planning and facilitation", 1], ["Architecture and analysis", 2]]],
    ["swot", [["Architecture and analysis", 1]]],
    ["zzz-nothing", []],
  ] as const)("search %s works across groups, and a group with no matches hides its heading", (query, expected) => {
    expect(templateSections(query).map((s) => [s.category.label, s.items.length])).toEqual(expected);
  });

  it.each([
    ["retro", ["Retro", "Start Stop Continue", "Mad Sad Glad", "4Ls", "Starfish", "Sailboat"]],
    ["kanban", ["Sprint planning", "Lean coffee"]],
    ["impact", ["2x2 Impact and Effort"]],
    ["sprint goal", ["Sprint planning"]],
    ["rationalisation", ["TIME"]],
    ["cloud migration", ["Migration strategy"]],
    ["radar", ["Technology radar"]],
    ["decision record", ["Architecture decision"]],
  ])("search %s finds %j", (query, labels) => {
    expect(templateSections(query).flatMap((s) => s.items.map((i) => i.label))).toEqual(labels);
  });

  it("each tile applies its template through plain actions, drops at its own size, and is off with the template reason", () => {
    const items = templateItems;
    const applyTemplate = vi.fn();
    items[0]?.create({ addNote: vi.fn(), addFrame: vi.fn(), applyTemplate, openTimer: vi.fn(), addShape: vi.fn() }, { x: 10, y: 20 });
    expect(applyTemplate).toHaveBeenCalledWith(TEMPLATES[0], { x: 10, y: 20 });
    const { width, height } = templateBounds(TEMPLATES[0]!);
    expect(items[0]?.dropSize).toEqual({ width, height });
    expect(items[0]?.preview).toEqual({ kind: "template", template: TEMPLATES[0] });
    for (const item of items) {
      expect(item.disabled(ctx)).toBeNull();
      expect(item.disabled({ ...ctx, templateReason: "Busy" })).toBe("Busy");
    }
  });
});

describe("fitting to a new template", () => {
  it("is animated with the view duration (the base duration's value), 0 with reduced motion", async () => {
    const { readFileSync } = await import("node:fs");
    const tokens = readFileSync(new URL("../src/styles/tokens.css", import.meta.url), "utf8");
    const reduced = tokens.slice(tokens.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced.slice(0, reduced.indexOf("}\n}"))).toMatch(/--sy-duration-base:\s*0ms;/);
    const view = readFileSync(new URL("../src/canvas/useCanvasView.ts", import.meta.url), "utf8");
    // v0.24.0: every view change uses navigation.ts viewDuration (VIEW_ANIMATION_MS, 0 with reduced motion).
    expect(view).toMatch(/viewDuration\(Boolean\(globalThis\.matchMedia\?\.\(MEDIA\.reducedMotion\)\.matches\)\)/);
    const { VIEW_ANIMATION_MS } = await import("../src/canvas/navigation");
    expect(tokens).toContain(`--sy-duration-base: ${VIEW_ANIMATION_MS}ms;`);
    // The board fits to the new frames with the animated fit (not an instant jump).
    const board = readFileSync(new URL("../src/canvas/RoomBoard.tsx", import.meta.url), "utf8");
    expect(board).toMatch(/const frames = templateFrames\(/);
    expect(board).toMatch(/canvas\.fit\(frames\);/);
  });
});
