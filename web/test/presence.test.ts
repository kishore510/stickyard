import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Participant } from "@stickyard/shared";
import { AVATAR_MAX, NAME_MAX_SHOWN, avatarStack, initials, peopleLabel, truncateName } from "../src/presence/avatars";
import { RESYNC_QUIET_MS, TOAST_BATCH_MS, TOAST_GAP_MS, TOAST_SHOW_MS, summarizePresence, type PresenceEvent } from "../src/presence/toasts";
import { alex, room, sam } from "./helpers/fakeRelay";

/*
 * Presence (web only, no protocol change): the avatar stack and join/leave toasts, from the
 * existing joined, participant_joined and participant_left messages.
 */

const person = (i: number, name = `P${i}`): Participant => ({ id: `PPPPPPPPPPPPP${String(i).padStart(3, "0")}`, name, colourIndex: i });

describe("avatar stack (pure)", () => {
  it(`shows you first, then others in arrival order, in ${AVATAR_MAX} places: the last is +N when there are more`, () => {
    expect(AVATAR_MAX).toBe(4);
    const people = [person(1), person(2), alex, person(3), person(4), person(5)];
    const { shown, overflow } = avatarStack(people, alex.id);
    expect(shown.map((s) => s.participant.id)).toEqual([alex.id, person(1).id, person(2).id]);
    expect(shown.map((s) => s.you)).toEqual([true, false, false]);
    expect(overflow).toBe(3);
  });

  it("no overflow when everyone fits; works before you're known", () => {
    expect(avatarStack([alex, sam], alex.id)).toEqual({ shown: [{ participant: alex, you: true }, { participant: sam, you: false }], overflow: 0 });
    expect(avatarStack([sam], null)).toEqual({ shown: [{ participant: sam, you: false }], overflow: 0 });
    expect(avatarStack([], null)).toEqual({ shown: [], overflow: 0 });
  });

  it("exactly the maximum shows everyone, one more shows +2 (never +1 in place of a face)", () => {
    const four = [alex, person(1), person(2), person(3)];
    expect(avatarStack(four, alex.id).overflow).toBe(0);
    const five = [...four, person(4)];
    const r = avatarStack(five, alex.id);
    expect(r.shown).toHaveLength(3);
    expect(r.overflow).toBe(2);
  });

  it("initials: plain text, one or two letters, whole characters (emoji and accents kept)", () => {
    expect(initials("Alex")).toBe("A");
    expect(initials("priya sharma")).toBe("PS");
    expect(initials("  Mary  Jane Watson ")).toBe("MJ");
    expect(initials("😀 Bob")).toBe("😀B");
    expect(initials("élodie")).toBe("É");
    expect(initials("<b>x</b>")).toBe("<");
    expect(initials("")).toBe("?");
  });

  it(`names are truncated to ${NAME_MAX_SHOWN} characters with an ellipsis, by whole characters`, () => {
    expect(truncateName("Sam")).toBe("Sam");
    expect(truncateName("A".repeat(NAME_MAX_SHOWN))).toBe("A".repeat(NAME_MAX_SHOWN));
    expect(truncateName("Bartholomew Montgomery")).toBe("Bartholomew Mon…");
    expect(Array.from(truncateName("😀".repeat(30)))).toHaveLength(NAME_MAX_SHOWN);
  });

  it("the accessible name states the number of people", () => {
    expect(peopleLabel(1)).toBe("Participants: 1 person in this session");
    expect(peopleLabel(5)).toBe("Participants: 5 people in this session");
    expect(peopleLabel(null)).toBe("Participants");
  });
});

describe("toast text (pure)", () => {
  const j = (p: Participant): PresenceEvent => ({ kind: "joined", id: p.id, name: p.name });
  const l = (p: Participant): PresenceEvent => ({ kind: "left", id: p.id, name: p.name });

  it.each<[string, PresenceEvent[], string | null]>([
    ["one join", [j(person(1, "Alex"))], "Alex joined"],
    ["one leave", [l(person(1, "Sam"))], "Sam left"],
    ["one each", [j(person(1, "Kai")), l(person(2, "Sam"))], "Kai joined, Sam left"],
    ["a burst of joins", Array.from({ length: 5 }, (_, i) => j(person(i))), "5 people joined"],
    ["a burst of leaves", Array.from({ length: 3 }, (_, i) => l(person(i))), "3 people left"],
    ["a mix", [j(person(1)), j(person(2)), l(person(3))], "2 people joined, 1 left"],
    ["a mix the other way", [j(person(1)), l(person(2)), l(person(3))], "1 person joined, 2 left"],
    ["someone reconnecting (left, then joined again under the same name)", [l(person(1, "Sam")), j(person(9, "Sam"))], null],
    ["a blip (joined, then left)", [j(person(1, "Kai")), l(person(1, "Kai"))], null],
    ["nothing", [], null],
  ])("%s", (_label, events, text) => {
    expect(summarizePresence(events)).toBe(text);
  });

  it("names are truncated, and stay plain text", () => {
    expect(summarizePresence([j(person(1, "<img src=x onerror=alert(1)>"))])).toBe("<img src=x oner… joined");
  });
});

describe("toasts from the session", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const kai = person(7, "Kai");
  const send = (t: ReturnType<typeof room>, message: unknown) => t.relay.handlers!.onMessage(JSON.stringify(message));

  it("none for the participant list on joining", async () => {
    const t = room();
    await vi.advanceTimersByTimeAsync(TOAST_BATCH_MS * 3);
    expect(t.views.every((v) => v.presenceToast === null)).toBe(true);
  });

  it("one join: a toast after the batch window, gone after a few seconds", async () => {
    const t = room();
    t.relay.arrive(kai);
    expect(t.view().participants.map((p) => p.name)).toEqual(["Alex", "Sam", "Kai"]);
    expect(t.view().presenceToast).toBeNull();
    await vi.advanceTimersByTimeAsync(TOAST_BATCH_MS);
    expect(t.view().presenceToast).toEqual({ seq: 1, text: "Kai joined" });
    await vi.advanceTimersByTimeAsync(TOAST_SHOW_MS);
    expect(t.view().presenceToast).toBeNull();
  });

  it("a burst of 20 rejoining is one summary toast", async () => {
    const t = room();
    for (let i = 0; i < 20; i++) t.relay.arrive(person(i));
    await vi.advanceTimersByTimeAsync(TOAST_BATCH_MS * 2);
    const toasts = new Set(t.views.flatMap((v) => (v.presenceToast ? [v.presenceToast.seq] : [])));
    expect(toasts.size).toBe(1);
    expect(t.view().presenceToast?.text).toBe("20 people joined");
  });

  it("someone else reconnecting (left and back under the same name) shows nothing", async () => {
    const t = room();
    t.relay.leave(sam.id);
    t.relay.arrive({ ...sam, id: "SSSSSSSSSSSSSSS2" });
    await vi.advanceTimersByTimeAsync(TOAST_BATCH_MS * 2);
    expect(t.views.every((v) => v.presenceToast === null)).toBe(true);
  });

  it("rate-limited: toasts are at least the gap apart, later events wait and are summed", async () => {
    const t = room();
    t.relay.arrive(kai);
    await vi.advanceTimersByTimeAsync(TOAST_BATCH_MS);
    expect(t.view().presenceToast?.text).toBe("Kai joined");
    t.relay.arrive(person(1, "Priya"));
    t.relay.arrive(person(2, "Lee"));
    await vi.advanceTimersByTimeAsync(TOAST_BATCH_MS);
    expect(t.view().presenceToast?.text).toBe("Kai joined");
    await vi.advanceTimersByTimeAsync(TOAST_GAP_MS);
    expect(t.view().presenceToast).toEqual({ seq: 2, text: "2 people joined" });
  });

  it("none for yourself", async () => {
    const t = room();
    send(t, { type: "participant_joined", participant: alex });
    await vi.advanceTimersByTimeAsync(TOAST_BATCH_MS * 2);
    expect(t.view().presenceToast).toBeNull();
  });

  it("a leave of someone unknown is ignored", async () => {
    const t = room();
    t.relay.leave("ZZZZZZZZZZZZZZZZ");
    await vi.advanceTimersByTimeAsync(TOAST_BATCH_MS * 2);
    expect(t.view().presenceToast).toBeNull();
  });

  it("none for the churn of your own reconnect; someone new still gets one", async () => {
    const t = room();
    t.relay.arrive(kai);
    await vi.advanceTimersByTimeAsync(TOAST_BATCH_MS + TOAST_SHOW_MS);
    t.relay.drop();
    // A relay restart: Sam and Kai come back after you, with new ids.
    t.relay.others = [];
    await vi.advanceTimersByTimeAsync(1000);
    t.relay.open();
    expect(t.view().status).toBe("joined");
    t.relay.arrive({ ...sam, id: "SSSSSSSSSSSSSSS2" });
    t.relay.arrive({ ...kai, id: "KKKKKKKKKKKKKKK2" });
    await vi.advanceTimersByTimeAsync(TOAST_BATCH_MS * 2);
    expect(t.view().presenceToast).toBeNull();
    t.relay.arrive(person(3, "Priya"));
    await vi.advanceTimersByTimeAsync(TOAST_BATCH_MS * 2);
    expect(t.view().presenceToast?.text).toBe("Priya joined");
    // After the quiet period a returning name is news again.
    await vi.advanceTimersByTimeAsync(RESYNC_QUIET_MS);
    t.relay.leave("SSSSSSSSSSSSSSS2");
    await vi.advanceTimersByTimeAsync(TOAST_BATCH_MS + TOAST_GAP_MS);
    expect(t.view().presenceToast?.text).toBe("Sam left");
  });

  it("events waiting at a drop are forgotten; nothing shows while disconnected", async () => {
    const t = room();
    t.relay.arrive(kai);
    t.relay.drop();
    await vi.advanceTimersByTimeAsync(TOAST_BATCH_MS * 2);
    expect(t.views.every((v) => v.presenceToast === null)).toBe(true);
  });

  it("leaving stops the timers", async () => {
    const t = room();
    t.relay.arrive(kai);
    t.session.close();
    const n = t.views.length;
    await vi.advanceTimersByTimeAsync(TOAST_BATCH_MS * 2);
    expect(t.views.length).toBe(n);
  });
});
