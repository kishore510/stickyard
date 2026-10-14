import { CONNECTOR_DEFAULTS, NOTE_DEFAULTS } from "@stickyard/shared";
import { afterAll, expect, inject, it } from "vitest";
import { Raw, clientKey, sleep } from "../harness";
import { closeAll, openRoom, relayBoard, report, type Room } from "../room";

/*
 * Scenario 5: a locked board. Pages refuse a guest's changes up front; a raw guest socket that
 * sends every board-changing message anyway gets board_locked for each and changes nothing, while
 * the host's changes go through and reactions and votes still work.
 */

const relay = inject("relayUrl");
let room: Room | null = null;
afterAll(() => room && closeAll(room));

it("guests are refused on a locked board, the host is not", async () => {
  room = await openRoom(relay, 12);
  const { host, pages } = room;
  host.session.addNote({ x: 300, y: 300, color: "yellow", text: "Before the lock" });
  host.session.addShape({ kind: "rect", x: 800, y: 300 });
  host.session.addFrame({ x: 1200, y: 300, color: "blue", title: "Frame" });
  await host.until((v) => v.board.notes.some((n) => n.confirmed) && v.board.shapes.some((s) => s.confirmed) && v.board.frames.some((f) => f.confirmed), 10_000, "items");
  const noteId = host.view.board.notes[0]?.note.id as string;
  const shapeId = host.view.board.shapes[0]?.shape.id as string;
  const frameId = host.view.board.frames[0]?.frame.id as string;
  host.session.addConnector({ start: { item: noteId, anchor: "auto" }, end: { item: shapeId, anchor: "auto" } });
  host.session.createGroup([noteId, shapeId], { label: "Pair" });
  await host.until((v) => v.board.connectors.some((c) => c.confirmed) && v.board.groups.some((g) => g.confirmed), 10_000, "arrow and group");
  const arrowId = host.view.board.connectors[0]?.connector.id as string;
  const groupId = host.view.board.groups[0]?.group.id as string;

  expect(host.session.setLock(true)).toBe(true);
  await Promise.all(pages.map((p) => p.until((v) => v.locked, 10_000, "locked")));
  const before = (await relayBoard(relay, room)).board;

  // A guest page: the canvas hides the tools while locked (RoomBoard), so this is the session alone.
  // Its add goes out, the relay refuses it with board_locked, and the page rolls it back.
  const guest = pages[3]!;
  const sentBefore = guest.frames.filter((f) => f.dir === "out").length;
  guest.session.addNote({ x: 10, y: 10, color: "pink", text: "Guest note" });
  await guest.until((v) => !v.board.notes.some((n) => n.note.text === "Guest note"), 10_000, "rolled back");
  const guestMessages = guest.frames.filter((f) => f.dir === "out").slice(sentBefore).map((f) => /"type":"(\w+)"/.exec(f.raw)?.[1]);
  const guestRefused = guest.inbound().some((m) => m.type === "error" && m.code === "board_locked");

  // A raw guest sends every board-changing message anyway.
  const raw = new Raw(relay, room.code, room.meter);
  await raw.open();
  await raw.enter("Raw guest", clientKey());
  const writes: unknown[] = [
    { type: "noteAdd", clientRef: "a", x: 10, y: 10, color: "pink", text: "x" },
    { type: "noteEdit", id: noteId, text: "changed" },
    { type: "noteMove", id: noteId, x: 900, y: 900, final: true },
    { type: "noteResize", id: noteId, x: 300, y: 300, w: 300, h: 300, final: true },
    { type: "noteDelete", id: noteId },
    { type: "noteBatch", ops: [{ op: "delete", id: noteId }], final: true },
    { type: "notesOrder", ids: [noteId], action: "back" },
    { type: "frameAdd", clientRef: "b", x: 10, y: 10, color: "neutral", title: "" },
    { type: "frameEdit", id: frameId, title: "changed" },
    { type: "frameMove", id: frameId, x: 10, y: 10, final: true },
    { type: "frameResize", id: frameId, x: 10, y: 10, w: 300, h: 300, final: true },
    { type: "frameDelete", id: frameId },
    { type: "shapeAdd", clientRef: "c", kind: "oval", x: 10, y: 10 },
    { type: "shapeEdit", id: shapeId, text: "changed" },
    { type: "shapeMove", id: shapeId, x: 10, y: 10, final: true },
    { type: "shapeResize", id: shapeId, x: 10, y: 10, w: 100, h: 100, final: true },
    { type: "shapeDelete", id: shapeId },
    { type: "shapeBatch", ops: [{ op: "delete", id: shapeId }], final: true },
    { type: "itemsAdd", clientRef: "d", notes: [{ ref: "n", x: 10, y: 10, text: "", ...NOTE_DEFAULTS, color: "green" }] },
    { type: "connectorAdd", clientRef: "e", start: { x: 10, y: 10 }, end: { x: 400, y: 400 }, ...CONNECTOR_DEFAULTS },
    { type: "connectorUpdate", id: arrowId, dash: "dotted" },
    { type: "connectorDelete", id: arrowId },
    { type: "groupCreate", clientRef: "f", label: "", color: "neutral", members: [noteId, shapeId] },
    { type: "groupUpdate", id: groupId, label: "changed" },
    { type: "groupMembers", id: groupId, add: [], remove: [noteId] },
    { type: "groupDelete", id: groupId },
  ];
  for (const m of writes) {
    raw.send(m);
    await sleep(60);
  }
  await sleep(800);
  const replies = raw.queue.filter((m) => m.type === "error").map((m) => (m.type === "error" ? m.code : ""));
  const after = (await relayBoard(relay, room)).board;
  const unchanged = JSON.stringify(before) === JSON.stringify(after);

  // Reactions and votes still work for guests on a locked board.
  raw.send({ type: "claimVoter", key: clientKey() });
  await raw.next("voterGranted");
  raw.send({ type: "reactionSet", noteId, key: "thumbs_up", on: true });
  const reacted = await raw.next("reactionMine");

  // The host's changes go through.
  host.session.editNote(noteId, "Host edit while locked");
  await pages[5]!.until((v) => v.board.notes.some((n) => n.note.text === "Host edit while locked"), 10_000, "host edit");

  report("5. lock", {
    guestPageSent: guestMessages,
    guestPageRefusedAndRolledBack: guestRefused,
    rawWritesSent: writes.length,
    rawReplies: [...new Set(replies)],
    boardLockedReplies: replies.filter((c) => c === "board_locked").length,
    boardUnchanged: unchanged,
    guestReactionAllowed: reacted.on,
    hostEditWentThrough: true,
  });
  raw.close();
  expect(guestRefused).toBe(true);
  expect(replies.filter((c) => c === "board_locked").length).toBe(writes.length);
  expect(unchanged).toBe(true);
  expect(reacted.on).toBe(true);
});
