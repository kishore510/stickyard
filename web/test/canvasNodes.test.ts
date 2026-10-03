import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION, type Note, NOTE_DEFAULTS, type Participant } from "@stickyard/shared";
import type { SocketFactory, SocketHandlers } from "../src/connection/socket";
import { BOARD_NODE_ID, createDragHandlers, createNoteNodeMapper, type NoteFlowNode } from "../src/canvas/nodes";
import { RoomSession, type RoomView } from "../src/rooms/session";
import { EMPTY_SELECTION, selectOnly } from "../src/canvas/selection";

/*
 * The canvas layer between React Flow and the room session: notes in, memoised nodes out;
 * React Flow's drag events in, session moves out. Driven with a real RoomSession.
 */

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

const alex: Participant = { id: "AAAAAAAAAAAAAAAA", name: "Alex", colourIndex: 0 };
const sam: Participant = { id: "BBBBBBBBBBBBBBBB", name: "Sam", colourIndex: 1 };
const N1 = "NNNNNNNNNNNNNNN1";
const N2 = "NNNNNNNNNNNNNNN2";
const one: Note = { id: N1, x: 40, y: 60, ...NOTE_DEFAULTS, text: "One", color: "yellow", z: 0, rev: 1, authorId: sam.id };
const two: Note = { id: N2, x: 400, y: 300, ...NOTE_DEFAULTS, text: "Two", color: "blue", z: 0, rev: 1, authorId: sam.id };

function room(notes: Note[] = [one, two]) {
  let socket: FakeSocket | undefined;
  let view: RoomView | undefined;
  const createSocket: SocketFactory = (_url, handlers) => (socket = new FakeSocket(handlers));
  const session = new RoomSession({
    url: "wss://relay.example.test/ws?room=CODE",
    createSocket,
    checkCode: () => Promise.resolve("valid"),
    onChange: (v) => (view = v),
  });
  session.join("Alex");
  const sock = () => {
    if (!socket) throw new Error("no socket");
    return socket;
  };
  sock().handlers.onOpen();
  sock().receive({ type: "welcome", protocolVersion: PROTOCOL_VERSION });
  sock().receive({ type: "joined", you: alex, participants: [alex, sam] });
  sock().receive({ type: "snapshot", notes });
  const map = createNoteNodeMapper();
  const nodes = () => {
    if (!view) throw new Error("no view");
    return map(view.board, view.status === "joined");
  };
  const drag = createDragHandlers({
    startDrag: (id) => session.startDrag(id),
    moveNote: (id, x, y, final) => session.moveNote(id, x, y, final),
  });
  const node = (id: string) => {
    const n = nodes().find((m): m is NoteFlowNode => m.type === "note" && m.id === id);
    if (!n) throw new Error(`no node ${id}`);
    return n;
  };
  const moves = () => sock().sent.filter((m) => m.type === "noteMove");
  const board = () => {
    if (!view) throw new Error("no view");
    return view.board;
  };
  return { session, sock, nodes, node, drag, moves, board };
}

/** What React Flow reports while a node is dragged to (x, y). */
const dragTo = (r: ReturnType<typeof room>, id: string, x: number, y: number) =>
  r.drag.onNodesChange([{ type: "position", id, position: { x, y }, dragging: true }]);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("notes as React Flow nodes", () => {
  it("one node per note at its board position, above a bounded board node", () => {
    const r = room();
    const nodes = r.nodes();
    expect(nodes[0]?.id).toBe(BOARD_NODE_ID);
    expect(nodes[0]?.draggable).toBe(false);
    expect(nodes.slice(1).map((n) => [n.id, n.position])).toEqual([
      [N1, { x: 40, y: 60 }],
      [N2, { x: 400, y: 300 }],
    ]);
  });

  it("nodes are referentially stable: a remote move replaces only the moved note's node", () => {
    const r = room();
    const before = r.nodes();
    r.sock().receive({ type: "noteMoved", id: N2, x: 500, y: 320, rev: 1, final: false });
    const after = r.nodes();
    expect(after).not.toBe(before);
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[1]);
    expect(after[2]).not.toBe(before[2]);
    expect(after[2]?.position).toEqual({ x: 500, y: 320 });
  });

  it("unconfirmed notes, and every note while disconnected, can't be dragged", () => {
    const r = room([]);
    const id = r.session.addNote({ x: 10, y: 10, color: "pink" });
    expect(r.node(id ?? "").draggable).toBe(false);
    r.sock().handlers.onClose();
    const r2 = room();
    r2.sock().handlers.onClose();
    expect(r2.nodes().slice(1).every((n) => n.draggable === false)).toBe(true);
  });
});

describe("dragging through the canvas layer", () => {
  it("a drag sends throttled moves, then one final move on drop", () => {
    const r = room();
    r.drag.onNodeDragStart(r.node(N1));
    dragTo(r, N1, 50, 70);
    dragTo(r, N1, 60, 80);
    expect(r.node(N1).position).toEqual({ x: 60, y: 80 });
    r.drag.onNodeDragStop({ ...r.node(N1), position: { x: 65.4, y: 90.6 } });
    expect(r.moves()).toEqual([
      { type: "noteMove", id: N1, x: 50, y: 70, final: false },
      { type: "noteMove", id: N1, x: 65, y: 91, final: true },
    ]);
  });

  it("drag positions are clamped to the board", () => {
    const r = room();
    r.drag.onNodeDragStart(r.node(N1));
    dragTo(r, N1, -500, -20);
    expect(r.node(N1).position).toEqual({ x: 0, y: 0 });
  });

  it("a remote noteMoved for the note being dragged is ignored until drop", () => {
    const r = room();
    r.drag.onNodeDragStart(r.node(N1));
    dragTo(r, N1, 50, 70);
    r.sock().receive({ type: "noteMoved", id: N1, x: 900, y: 900, rev: 1, final: false });
    expect(r.node(N1).position).toEqual({ x: 50, y: 70 });
    // Other notes still follow remote moves.
    r.sock().receive({ type: "noteMoved", id: N2, x: 450, y: 310, rev: 1, final: false });
    expect(r.node(N2).position).toEqual({ x: 450, y: 310 });
  });

  it("a remote delete mid-drag removes the note; later drag events are no-ops", () => {
    const r = room();
    r.drag.onNodeDragStart(r.node(N1));
    dragTo(r, N1, 50, 70);
    r.sock().receive({ type: "noteDeleted", id: N1 });
    expect(r.nodes().map((n) => n.id)).toEqual([BOARD_NODE_ID, N2]);
    const sent = r.moves().length;
    dragTo(r, N1, 80, 90);
    r.drag.onNodeDragStop({ id: N1, position: { x: 80, y: 90 } });
    vi.advanceTimersByTime(1000);
    expect(r.moves()).toHaveLength(sent);
  });

  it("a stale (lower rev) update is still rejected through the canvas layer", () => {
    const r = room([{ ...one, rev: 5 }]);
    r.sock().receive({ type: "noteMoved", id: N1, x: 700, y: 700, rev: 4, final: true });
    expect(r.node(N1).position).toEqual({ x: 40, y: 60 });
    r.sock().receive({ type: "noteUpdated", note: { ...one, text: "Old", rev: 3 } });
    expect(r.node(N1).data.entry.note.text).toBe("One");
  });

  it("a drag that the session refuses (not connected) doesn't move anything", () => {
    const r = room();
    r.sock().handlers.onClose();
    r.drag.onNodeDragStart(r.node(N1));
    dragTo(r, N1, 300, 300);
    expect(r.node(N1).position).toEqual({ x: 40, y: 60 });
  });

  it("ignores changes that aren't drags (dimensions, selection) and the board node", () => {
    const r = room();
    r.drag.onNodesChange([
      { type: "dimensions", id: N1, dimensions: { width: 1, height: 1 } },
      { type: "select", id: N1, selected: true },
      { type: "position", id: BOARD_NODE_ID, position: { x: 5, y: 5 }, dragging: true },
    ]);
    expect(r.moves()).toEqual([]);
    expect(r.node(N1).position).toEqual({ x: 40, y: 60 });
  });
});

describe("tools and selection on nodes", () => {
  it("notes take pointer events under every tool, so double-click and focus reach them under Hand", () => {
    // Regression: React Flow gives a node that is neither draggable nor selectable
    // pointer-events: none, so under Hand (notes not draggable) clicks went to the pane.
    const r = room();
    const map = createNoteNodeMapper();
    for (const movable of [true, false]) {
      const notes = map(r.board(), true, movable).slice(1);
      expect(notes.every((n) => n.style?.pointerEvents === "all"), `movable ${movable}`).toBe(true);
    }
    // Hand: not draggable (so a drag starting on a note pans), but still clickable.
    expect(map(r.board(), true, false)[1]?.draggable).toBe(false);
    // The board itself never takes pointer events (a click there is a click on empty space).
    expect(map(r.board(), true, true)[0]?.style?.pointerEvents).toBe("none");
  });

  it("nodes carry their selected state; selecting one note replaces only that note's node", () => {
    const r = room();
    const map = createNoteNodeMapper();
    const board = r.board();
    const before = map(board, true, true, EMPTY_SELECTION);
    const after = map(board, true, true, selectOnly(EMPTY_SELECTION, N2));
    expect(before.slice(1).map((n) => n.type === "note" && n.data.selected)).toEqual([false, false]);
    expect(after[1]).toBe(before[1]);
    expect(after[2]).not.toBe(before[2]);
    expect(after[2]?.type === "note" && after[2].data.selected).toBe(true);
  });

  it("node size comes from the note size lookup", () => {
    const r = room();
    expect(r.node(N1).width).toBe(160);
    expect(r.node(N1).height).toBe(160);
  });
});
