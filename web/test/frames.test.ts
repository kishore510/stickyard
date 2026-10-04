import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FRAME_COLORS,
  FRAME_DEFAULTS,
  FRAME_DEFAULT_H,
  FRAME_DEFAULT_W,
  FRAME_MAX_H,
  FRAME_MAX_W,
  FRAME_MIN_H,
  FRAME_MIN_W,
  MAX_BATCH_ENTRIES,
  NOTE_DEFAULTS,
  NOTE_Z_LIMIT,
  PROTOCOL_VERSION,
  type Frame,
  type Note,
  type Participant,
} from "@stickyard/shared";
import type { SocketFactory, SocketHandlers } from "../src/connection/socket";
import { BOARD_NODE, FRAME_Z_INDEX, createDragHandlers, createNoteNodeMapper, type FrameFlowNode, type NoteFlowNode } from "../src/canvas/nodes";
import { EMPTY_SELECTION, selectOnly } from "../src/canvas/selection";
import { useBoardUi } from "../src/canvas/uiStore";
import { applyFrameUpdated, applyFramesSnapshot, findFrame, framedNotes, setFrameDraft } from "../src/frames/board";
import { FRAME_COLOR_NAMES, frameColourStyle } from "../src/frames/style";
import { EMPTY_BOARD, applySnapshot, findNote, localId } from "../src/notes/board";
import { PALETTE_CATEGORIES, paletteSections } from "../src/palette/registry";
import { NOTICES, RoomSession, type RoomView } from "../src/rooms/session";

/* Slice frames (protocol v9): frames on the page. Generic fixtures (Start, Stop, Continue). */

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

const alex: Participant = { id: "AAAAAAAAAAAAAAAA", name: "Alex", colourIndex: 0, host: false };
const sam: Participant = { id: "BBBBBBBBBBBBBBBB", name: "Sam", colourIndex: 1, host: false };
const noteId = (i: number) => `note${String(i).padStart(12, "0")}`;
const frameId = (i: number) => `frame${String(i).padStart(11, "0")}`;
const note = (i: number, x: number, y: number, extra: Partial<Note> = {}): Note => ({
  id: noteId(i),
  x,
  y,
  ...NOTE_DEFAULTS,
  text: "",
  color: "yellow",
  z: i,
  rev: 1,
  authorId: sam.id,
  ...extra,
});
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
  authorId: sam.id,
  ...extra,
});

function session({ frames = [] as Frame[] | null, notes = [] as Note[] } = {}) {
  let socket: FakeSocket | null = null;
  const views: RoomView[] = [];
  const createSocket: SocketFactory = (_url, handlers) => (socket = new FakeSocket(handlers));
  const confirmed: [string, string][] = [];
  const s = new RoomSession({
    url: "wss://relay.example.test/ws?room=CODE",
    createSocket,
    checkCode: () => Promise.resolve("valid"),
    onChange: (v) => views.push(v),
    onFrameConfirmed: (from, to) => confirmed.push([from, to]),
  });
  s.join("Alex");
  const sock = () => {
    if (!socket) throw new Error("no socket");
    return socket;
  };
  sock().handlers.onOpen();
  sock().receive({ type: "welcome", protocolVersion: PROTOCOL_VERSION });
  sock().receive({ type: "joined", you: alex, participants: [alex, sam], locked: false, timer: null, voting: { state: "off", budget: 5, round: 0 } });
  sock().receive({ type: "snapshot", notes });
  if (frames) sock().receive({ type: "framesSnapshot", frames });
  const view = () => {
    const v = views.at(-1);
    if (!v) throw new Error("no view");
    return v;
  };
  const sent = (type: string) => sock().sent.filter((m) => m.type === type);
  return { session: s, sock, view, views, sent, confirmed };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  useBoardUi.getState().resetRoom();
});

describe("join: snapshot, then framesSnapshot", () => {
  it("the board is joined and synced after the notes snapshot; frames arrive with framesSnapshot", () => {
    const t = session({ frames: null, notes: [note(0, 10, 10)] });
    expect(t.view().status).toBe("joined");
    expect(t.view().synced).toBe(true);
    expect(t.view().board.notes).toHaveLength(1);
    expect(t.view().board.frames).toEqual([]);
    t.sock().receive({ type: "framesSnapshot", frames: [frame(0)] });
    expect(t.view().board.frames.map((f) => f.frame.title)).toEqual(["Start"]);
    // Notes are untouched by frames arriving.
    expect(t.view().board.notes[0]?.note.x).toBe(10);
  });

  it("without a framesSnapshot (older relay, or lost), notes still show and nothing errors or retries", () => {
    const t = session({ frames: null, notes: [note(0, 10, 10)] });
    vi.advanceTimersByTime(60_000);
    expect(t.view().status).toBe("joined");
    expect(t.view().board.frames).toEqual([]);
    expect(t.view().noteNotice).toBeNull();
    expect(t.sock().sent.filter((m) => m.type !== "hello" && m.type !== "join")).toEqual([]);
  });

  it("a frame message that arrives before framesSnapshot is kept: the snapshot merges by rev", () => {
    const t = session({ frames: null });
    t.sock().receive({ type: "frameAdded", frame: frame(1, { title: "Stop", rev: 1 }) });
    t.sock().receive({ type: "frameUpdated", frame: frame(0, { title: "Newer", rev: 3 }) });
    expect(t.view().board.frames).toHaveLength(2);
    t.sock().receive({ type: "framesSnapshot", frames: [frame(0, { title: "Older", rev: 2 }), frame(1, { title: "Stop", rev: 1 })] });
    expect(t.view().board.frames.map((f) => [f.frame.id, f.frame.title])).toEqual([
      [frameId(0), "Newer"],
      [frameId(1), "Stop"],
    ]);
  });

  it("applyFramesSnapshot keeps frames being added here (not confirmed yet)", () => {
    const t = session();
    const local = t.session.addFrame({ x: 10, y: 10, color: "blue" });
    expect(local).not.toBeNull();
    const board = applyFramesSnapshot(t.view().board, [frame(0)]);
    expect(board.frames.map((f) => f.frame.id).sort()).toEqual([frameId(0), local].sort());
  });
});

describe("session: frames", () => {
  it("addFrame is optimistic, sends frameAdd with plain data, and the server id replaces the local one", () => {
    const t = session();
    const id = t.session.addFrame({ x: 100, y: 120, color: "green", title: "Start" }) ?? "";
    expect(findFrame(t.view().board, id)?.frame).toMatchObject({ x: 100, y: 120, w: FRAME_DEFAULT_W, h: FRAME_DEFAULT_H, title: "Start", color: "green" });
    const add = t.sent("frameAdd")[0] as { clientRef: string };
    expect(add).toEqual({ type: "frameAdd", clientRef: add.clientRef, x: 100, y: 120, color: "green", title: "Start" });
    t.sock().receive({ type: "frameAdded", frame: frame(7, { x: 100, y: 120, color: "green" }), clientRef: add.clientRef });
    expect(findFrame(t.view().board, frameId(7))).toBeDefined();
    expect(findFrame(t.view().board, id)).toBeUndefined();
    expect(t.confirmed).toEqual([[id, frameId(7)]]);
  });

  it("a title typed before the add is confirmed goes out as one frameEdit once it is", () => {
    const t = session();
    const id = t.session.addFrame({ x: 0, y: 0, color: "neutral" }) ?? "";
    t.session.editFrame(id, { title: "Continue" });
    expect(t.sent("frameEdit")).toEqual([]);
    const add = t.sent("frameAdd")[0] as { clientRef: string };
    t.sock().receive({ type: "frameAdded", frame: frame(3, { title: "" }), clientRef: add.clientRef });
    expect(t.sent("frameEdit")).toEqual([{ type: "frameEdit", id: frameId(3), title: "Continue" }]);
  });

  it("frames_full rolls the add back and says so", () => {
    const t = session();
    t.session.addFrame({ x: 0, y: 0, color: "neutral" });
    const add = t.sent("frameAdd")[0] as { clientRef: string };
    t.sock().receive({ type: "error", code: "frames_full", message: "Full.", clientRef: add.clientRef });
    expect(t.view().board.frames).toEqual([]);
    expect(t.view().noteNotice).toBe(NOTICES.framesFull);
  });

  it("editFrame cleans the title, is optimistic and rolls back when refused", () => {
    const t = session({ frames: [frame(0)] });
    t.session.editFrame(frameId(0), { title: "  Stop\nnow ", color: "pink" });
    expect(findFrame(t.view().board, frameId(0))?.frame).toMatchObject({ title: "Stop now", color: "pink" });
    expect(t.sent("frameEdit")).toEqual([{ type: "frameEdit", id: frameId(0), title: "Stop now", color: "pink" }]);
    t.sock().receive({ type: "error", code: "rate_limited", message: "Slow down.", frameId: frameId(0) });
    expect(findFrame(t.view().board, frameId(0))?.frame).toMatchObject({ title: "Start", color: "neutral" });
  });

  it("dragging a frame carries the notes whose centre is inside it, by the same clamped delta", () => {
    const t = session({ frames: [frame(0, { x: 100, y: 100, w: 640, h: 400 })], notes: [note(0, 150, 150), note(1, 700, 200), note(2, 1500, 1500)] });
    expect(t.session.startFrameDrag(frameId(0), true)).toBe(true);
    t.session.moveFrame(frameId(0), 300, 200, false);
    const board = t.view().board;
    expect(findNote(board, noteId(0))?.note).toMatchObject({ x: 350, y: 250 });
    expect(findNote(board, noteId(1))?.note).toMatchObject({ x: 700, y: 200 });
    t.session.moveFrame(frameId(0), 300, 200, true);
    expect(t.sent("frameMove").at(-1)).toEqual({ type: "frameMove", id: frameId(0), x: 300, y: 200, final: true, noteIds: [noteId(0)] });
    expect(t.sent("frameMove")[0]).toMatchObject({ final: false, noteIds: [noteId(0)] });
  });

  it("Alt (carry: false) moves the frame alone", () => {
    const t = session({ frames: [frame(0)], notes: [note(0, 150, 150)] });
    t.session.startFrameDrag(frameId(0), false);
    t.session.moveFrame(frameId(0), 300, 300, true);
    expect(findNote(t.view().board, noteId(0))?.note).toMatchObject({ x: 150, y: 150 });
    expect(t.sent("frameMove").at(-1)).toEqual({ type: "frameMove", id: frameId(0), x: 300, y: 300, final: true });
  });

  it("a frame holding more than the carry cap moves alone and says so; it never carries some", () => {
    const notes = Array.from({ length: MAX_BATCH_ENTRIES + 1 }, (_, i) => note(i, 120 + i, 120));
    const t = session({ frames: [frame(0, { w: 1200, h: 600 })], notes });
    t.session.startFrameDrag(frameId(0), true);
    expect(t.view().noteNotice).toBe(NOTICES.frameTooFull);
    t.session.moveFrame(frameId(0), 300, 300, true);
    expect(t.sent("frameMove").at(-1)).toEqual({ type: "frameMove", id: frameId(0), x: 300, y: 300, final: true });
    expect(findNote(t.view().board, noteId(0))?.note.x).toBe(120);
  });

  it("remote moves and resizes of a frame held here are confirmed but not shown", () => {
    const t = session({ frames: [frame(0)] });
    t.session.startFrameDrag(frameId(0), false);
    t.session.moveFrame(frameId(0), 300, 300, false);
    t.sock().receive({ type: "frameMoved", id: frameId(0), x: 900, y: 900, rev: 2, final: true });
    expect(findFrame(t.view().board, frameId(0))?.frame).toMatchObject({ x: 300, y: 300 });
    expect(findFrame(t.view().board, frameId(0))?.confirmed).toMatchObject({ x: 900, y: 900, rev: 2 });
  });

  it("a remote frameMoved moves the carried notes too, in one view update", () => {
    const t = session({ frames: [frame(0)], notes: [note(0, 150, 150)] });
    const before = t.views.length;
    t.sock().receive({ type: "frameMoved", id: frameId(0), x: 200, y: 200, rev: 2, final: true, notes: [{ id: noteId(0), x: 250, y: 250, rev: 2 }] });
    expect(t.views.length - before).toBe(1);
    expect(findNote(t.view().board, noteId(0))?.note).toMatchObject({ x: 250, y: 250 });
    expect(findFrame(t.view().board, frameId(0))?.frame).toMatchObject({ x: 200, y: 200 });
  });

  it("a refused carried move rolls back the frame and its notes", () => {
    const t = session({ frames: [frame(0)], notes: [note(0, 150, 150)] });
    t.session.startFrameDrag(frameId(0), true);
    t.session.moveFrame(frameId(0), 500, 500, true);
    t.sock().receive({ type: "error", code: "rate_limited", message: "Slow down.", frameId: frameId(0), noteIds: [noteId(0)] });
    expect(findFrame(t.view().board, frameId(0))?.frame).toMatchObject({ x: 100, y: 100 });
    expect(findNote(t.view().board, noteId(0))?.note).toMatchObject({ x: 150, y: 150 });
  });

  it("resizing clamps to frame sizes and sends live then final", () => {
    const t = session({ frames: [frame(0)] });
    t.session.startFrameResize(frameId(0));
    t.session.resizeFrame(frameId(0), { x: 100, y: 100, w: 10, h: 99999 }, true);
    expect(findFrame(t.view().board, frameId(0))?.frame).toMatchObject({ w: FRAME_MIN_W, h: FRAME_MAX_H });
    expect(t.sent("frameResize").at(-1)).toMatchObject({ w: FRAME_MIN_W, h: FRAME_MAX_H, final: true });
  });

  it("deleting a frame sends frameDelete only: its notes stay", () => {
    const t = session({ frames: [frame(0)], notes: [note(0, 150, 150)] });
    t.session.deleteFrame(frameId(0));
    expect(t.view().board.frames).toEqual([]);
    expect(t.view().board.notes).toHaveLength(1);
    expect(t.sent("frameDelete")).toEqual([{ type: "frameDelete", id: frameId(0) }]);
    expect(t.sent("noteDelete")).toEqual([]);
    expect(t.sent("noteBatch")).toEqual([]);
  });

  it("frame changes are refused while disconnected", () => {
    const t = session({ frames: [frame(0)] });
    t.sock().handlers.onClose();
    expect(t.session.addFrame({ x: 0, y: 0, color: "neutral" })).toBeNull();
    expect(t.session.startFrameDrag(frameId(0), true)).toBe(false);
  });
});

describe("board: frame drafts", () => {
  it("a title being typed is never replaced by a remote edit", () => {
    let board = applyFramesSnapshot(applySnapshot(EMPTY_BOARD, []), [frame(0)]);
    board = setFrameDraft(board, frameId(0), "My typing");
    board = applyFrameUpdated(board, frame(0, { title: "Theirs", rev: 2 }));
    const entry = findFrame(board, frameId(0));
    expect(entry?.draft).toBe("My typing");
    expect(entry?.frame.title).toBe("Theirs");
  });

  it("framedNotes: notes whose centre is inside the frame", () => {
    const f = frame(0, { x: 100, y: 100, w: 400, h: 300 });
    const notes = [note(0, 100, 100), note(1, 430, 100), note(2, 30, 30), note(3, 300, 330)];
    // 0: centre (180,180) in; 1: centre (510,180) out; 2: centre (110,110) in; 3: centre (380,410) out.
    expect(framedNotes(f, notes).map((n) => n.id)).toEqual([noteId(0), noteId(2)]);
  });
});

describe("canvas: frame nodes", () => {
  const board = () => applyFramesSnapshot(applySnapshot(EMPTY_BOARD, [note(0, 150, 150, { z: -NOTE_Z_LIMIT }), note(1, 200, 200)]), [frame(0), frame(1, { x: 900 })]);
  const frames = (nodes: ReturnType<ReturnType<typeof createNoteNodeMapper>>) => nodes.filter((n): n is FrameFlowNode => n.type === "frame");
  const notes = (nodes: ReturnType<ReturnType<typeof createNoteNodeMapper>>) => nodes.filter((n): n is NoteFlowNode => n.type === "note");

  it("frames sit in a band behind every note (even one sent all the way back) and above the board", () => {
    const nodes = createNoteNodeMapper()(board(), true, true, EMPTY_SELECTION, { selected: null, wide: true });
    const lowestNote = Math.min(...notes(nodes).map((n) => n.zIndex ?? 0));
    for (const f of frames(nodes)) {
      expect(f.zIndex).toBe(FRAME_Z_INDEX);
      expect(f.zIndex).toBeLessThan(lowestNote);
      expect(f.zIndex).toBeGreaterThan(BOARD_NODE.zIndex ?? 0);
    }
    // Frames come before notes in the node list.
    expect(nodes.findIndex((n) => n.type === "frame")).toBeLessThan(nodes.findIndex((n) => n.type === "note"));
  });

  it("the frame body lets pointers through; only its title bar and border drag it", () => {
    const [f] = frames(createNoteNodeMapper()(board(), true, true, EMPTY_SELECTION, { selected: null, wide: true }));
    expect(f?.style?.pointerEvents).toBe("none");
    expect(f?.dragHandle).toBe(".sy-frame-handle");
    expect(f?.draggable).toBe(true);
  });

  it("phones show frames but can't move or resize them; resize handles only for the one selected frame", () => {
    const map = createNoteNodeMapper();
    expect(frames(map(board(), true, true, EMPTY_SELECTION, { selected: frameId(0), wide: false })).map((f) => [f.draggable, f.data.resizable])).toEqual([
      [false, false],
      [false, false],
    ]);
    expect(frames(map(board(), true, true, EMPTY_SELECTION, { selected: frameId(0), wide: true })).map((f) => f.data.resizable)).toEqual([true, false]);
  });

  it("unchanged frame nodes are reused", () => {
    const map = createNoteNodeMapper();
    const b = board();
    const first = frames(map(b, true, true, EMPTY_SELECTION, { selected: null, wide: true }));
    const again = frames(map(b, true, true, selectOnly(EMPTY_SELECTION, noteId(0)), { selected: null, wide: true }));
    expect(again[0]).toBe(first[0]);
  });

  it("dragging a frame starts a frame drag (carrying unless Alt is held) and sends its moves", () => {
    const calls: string[] = [];
    const drag = createDragHandlers({
      startDrag: () => true,
      moveNote: () => {},
      startFrameDrag: (id, carry) => {
        calls.push(`start ${id} ${carry}`);
        return true;
      },
      moveFrame: (id, x, y, final) => calls.push(`move ${id} ${x} ${y} ${final}`),
    });
    drag.onNodeDragStart({ id: frameId(0), type: "frame" }, { altKey: true });
    drag.onNodesChange([{ type: "position", id: frameId(0), dragging: true, position: { x: 120, y: 130 } }]);
    drag.onNodeDragStop({ id: frameId(0), position: { x: 140, y: 150 } });
    drag.onNodeDragStart({ id: frameId(1), type: "frame" }, { altKey: false });
    expect(calls).toEqual([`start ${frameId(0)} false`, `move ${frameId(0)} 120 130 false`, `move ${frameId(0)} 140 150 true`, `start ${frameId(1)} true`]);
  });
});

describe("selection: frames apart from notes", () => {
  it("selecting a frame clears the note selection, and selecting a note clears the frame", () => {
    const ui = useBoardUi.getState();
    ui.selectAll([noteId(0), noteId(1)]);
    ui.selectFrame(frameId(0));
    expect(useBoardUi.getState().selection.size).toBe(0);
    expect(useBoardUi.getState().frameSelected).toBe(frameId(0));
    useBoardUi.getState().select(noteId(0));
    expect(useBoardUi.getState().frameSelected).toBeNull();
    useBoardUi.getState().selectFrame(frameId(0));
    useBoardUi.getState().clearSelection();
    expect(useBoardUi.getState().frameSelected).toBeNull();
  });

  it("a frame id renamed from local to server keeps it selected", () => {
    useBoardUi.getState().selectFrame(localId("r1"));
    useBoardUi.getState().renameFrame(localId("r1"), frameId(2));
    expect(useBoardUi.getState().frameSelected).toBe(frameId(2));
  });
});

describe("palette: the Frames tile", () => {
  const state = { live: true, noteCount: 0, isHost: false };
  it("is in a Frames category on the panel (md and up) and not in the phone drawer", () => {
    const panel = paletteSections(PALETTE_CATEGORIES, "add", state, "", "panel");
    const drawer = paletteSections(PALETTE_CATEGORIES, "add", state, "", "drawer");
    expect(panel.map((s) => s.category.label)).toContain("Frames");
    expect(panel.find((s) => s.category.id === "frames")?.items.map((i) => i.label)).toEqual(["Frame"]);
    expect(drawer.map((s) => s.category.id)).not.toContain("frames");
  });

  it("creates a frame through plain actions, and is off with the frames reason", () => {
    const item = PALETTE_CATEGORIES.find((c) => c.id === "frames")?.items[0];
    const addFrame = vi.fn();
    item?.create({ addNote: vi.fn(), addFrame, applyTemplate: vi.fn(), openTimer: vi.fn() }, { x: 10, y: 20 });
    expect(addFrame).toHaveBeenCalledWith("neutral", { x: 10, y: 20 });
    expect(item?.disabled({ noteReason: null, frameReason: "Full", templateReason: null, timerReason: null })).toBe("Full");
    expect(item?.disabled({ noteReason: "Disconnected", frameReason: null, templateReason: null, timerReason: null })).toBeNull();
  });
});

describe("frame tokens", () => {
  const tokens = readFileSync(join(process.cwd(), "src/styles/tokens.css"), "utf8");
  const THEMES = [':root,\n[data-theme="light"]', '[data-theme="dark"]'];
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

  it("frame sizes match the shared protocol", () => {
    expect(tokens).toContain(`--sy-frame-min-w: ${FRAME_MIN_W}px;`);
    expect(tokens).toContain(`--sy-frame-min-h: ${FRAME_MIN_H}px;`);
    expect(tokens).toContain(`--sy-frame-max-w: ${FRAME_MAX_W}px;`);
    expect(tokens).toContain(`--sy-frame-max-h: ${FRAME_MAX_H}px;`);
    expect(tokens).toContain(`--sy-frame-default-w: ${FRAME_DEFAULT_W}px;`);
    expect(tokens).toContain(`--sy-frame-default-h: ${FRAME_DEFAULT_H}px;`);
  });

  it.each(THEMES)("every frame colour has fill, border and header tokens in %s, and the title is 4.5:1 on every header", (selector) => {
    const c = theme(selector);
    expect(c["frame-title"], "frame-title").toMatch(/^#[0-9a-f]{6}$/);
    for (const key of FRAME_COLORS) {
      expect(c[`frame-${key}-fill`], `${key} fill`).toMatch(/^#[0-9a-f]{8}$/);
      expect(c[`frame-${key}-border`], `${key} border`).toBeDefined();
      const header = c[`frame-${key}-header`];
      expect(header, `${key} header`).toMatch(/^#[0-9a-f]{6}$/);
      expect(contrast(c["frame-title"]!, header!), `title on ${key}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("each colour key has a name and maps to its tokens (vars only)", () => {
    for (const key of FRAME_COLORS) {
      expect(FRAME_COLOR_NAMES[key]).toBeTruthy();
      const style = frameColourStyle(key);
      expect(JSON.stringify(style)).toContain(`var(--sy-frame-${key}-fill)`);
      expect(JSON.stringify(style)).not.toMatch(/#[0-9a-f]{3,8}/i);
    }
  });
});
