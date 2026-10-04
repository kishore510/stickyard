// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useRoomUi } from "../src/rooms/roomStore";
import { voterKeyKey } from "../src/storage";
import { ROOM_ID, cleanupUi, inRoom, installUi, noteAt, server } from "./helpers/ui";

/*
 * Protocol v13 plumbing in the real page (no visible voting UI yet): the room screen makes and
 * keeps this device's voter key for the room, sends it only in claimVoter, publishes the voting
 * state to roomStore, and forgets the key when the session ends.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => installUi());
afterEach(() => cleanupUi());

describe("the voter key in the page", () => {
  it("is made once for the room, kept, and sent only in claimVoter; never shown or in the address", async () => {
    const socket = await inRoom({ notes: [noteAt(1)] });
    const key = localStorage.getItem(voterKeyKey(ROOM_ID));
    expect(key).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(socket.ofType("claimVoter")).toEqual([{ type: "claimVoter", key }]);
    expect(socket.sent.filter((m) => JSON.stringify(m).includes(key!)).map((m) => m.type)).toEqual(["claimVoter"]);
    expect(document.body.textContent).not.toContain(key);
    expect(document.body.innerHTML).not.toContain(key);
    expect(window.location.href).not.toContain(key);
  });

  it("publishes the voting state, my votes, dots left and results to roomStore", async () => {
    const socket = await inRoom({ notes: [noteAt(1)] });
    await server(socket, { data: { type: "voterGranted", remaining: 4, mine: [{ noteId: noteAt(1).id, count: 1 }] } });
    await server(socket, { data: { type: "votingChanged", voting: { state: "open", budget: 5, round: 1 } } });
    expect(useRoomUi.getState().room).toMatchObject({ voting: { state: "open", budget: 5, round: 1 }, remaining: 5, results: null, isVoter: true });
    await server(socket, { data: { type: "voterGranted", remaining: 4, mine: [{ noteId: noteAt(1).id, count: 1 }] } });
    const room = useRoomUi.getState().room!;
    expect(Object.fromEntries(room.myVotes)).toEqual({ [noteAt(1).id]: 1 });
    expect(room.remaining).toBe(4);
    expect(room.voteSet(noteAt(1).id, 2)).toBe(true);
    expect(socket.ofType("voteSet")).toEqual([{ type: "voteSet", noteId: noteAt(1).id, count: 2 }]);
    await server(socket, { data: { type: "voteConfirmed", noteId: noteAt(1).id, count: 2, remaining: 3 } });
    await server(socket, { data: { type: "votingChanged", voting: { state: "closed", budget: 5, round: 1 } } });
    await server(socket, { data: { type: "votesRevealed", round: 1, totals: [{ noteId: noteAt(1).id, count: 6 }] } });
    expect(useRoomUi.getState().room?.results).toEqual([{ noteId: noteAt(1).id, count: 6 }]);
  });

  it("is forgotten when the session ends", async () => {
    const socket = await inRoom({ host: true });
    expect(localStorage.getItem(voterKeyKey(ROOM_ID))).not.toBeNull();
    await server(socket, { data: { type: "sessionEnded" } });
    expect(localStorage.getItem(voterKeyKey(ROOM_ID))).toBeNull();
  });
});
