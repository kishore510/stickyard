// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION, type Participant } from "@stickyard/shared";
import { alex, boardBar, cleanupUi, inRoom, installUi, lastSocket, sam, server, setReducedMotion, settle, tipOf, type FakeWebSocket } from "./helpers/ui";

/*
 * Follow and Bring to me in the page (v0.31.0, part 2 of 2): Follow / Stop following in
 * Participants, the chip ("Following Sam", "Waiting for Sam's view.") with Stop, the view moving
 * with the leader without that counting as my own move, my own pan or zoom stopping it, the
 * notices for followEnded and followers_full, "N following you", the host's Bring to me (host
 * only, 5 seconds off after each), the banner a Bring to me shows (Go there, Dismiss, Escape,
 * replace, a minute), resets, the one polite announcer, and names as plain text.
 */

beforeEach(installUi);
afterEach(async () => {
  vi.useRealTimers();
  await cleanupUi();
});

const jo: Participant = { id: "CCCCCCCCCCCCCCCC", name: "Jo", colourIndex: 2, host: false };
const hostSam: Participant = { ...sam, host: true };

const q = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector);
const followButton = (id: string) => q<HTMLButtonElement>(`[data-follow="${id}"]`);
const chip = () => q("[data-follow-chip]");
const stopButton = () => q<HTMLButtonElement>("[data-follow-stop]");
const announcer = () => q("[data-follow-announcer]");
const notice = () => q("[data-follow-notice]");
const followers = () => q("[data-followers]");
const banner = () => q("[data-brought-banner]");
const bannerText = () => q("[data-brought-text]");
const goThere = () => q<HTMLButtonElement>("[data-brought-go]");
const dismiss = () => q<HTMLButtonElement>("[data-brought-dismiss]");
const bring = () => q<HTMLButtonElement>("[data-bring-to-me]");

/** React Flow treats a canvas with no size (happy-dom) as 500 x 500: half of it. */
const HALF = 250;
/** The transform that centres the board point (x, y) at this zoom. */
const centredOn = (x: number, y: number, zoom: number) => [HALF - x * zoom, HALF - y * zoom, zoom];

/** React Flow's viewport transform: [x, y, zoom]. */
function transform(): [number, number, number] {
  const style = q(".react-flow__viewport")?.style.transform ?? "";
  const m = /translate\((-?[\d.e+-]+)px,\s*(-?[\d.e+-]+)px\)\s*scale\((-?[\d.e+-]+)\)/.exec(style);
  if (!m) throw new Error(`no viewport transform in "${style}"`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

async function openParticipants() {
  const opener = q('header [aria-label^="Participants"]');
  if (!opener) throw new Error("no Participants button");
  await act(async () => opener.click());
  await settle();
}

async function press(el: HTMLElement | null) {
  if (!el) throw new Error("nothing to press");
  await act(async () => el.click());
  await settle();
}

async function key(k: string, target: EventTarget = window) {
  await act(async () => target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })));
  await settle();
}

/** Joins (Alex), opens Participants and follows Sam. */
async function following(opts: Parameters<typeof inRoom>[0] = {}, who: Participant = sam) {
  const socket = await inRoom({ others: [sam, jo], ...opts });
  await openParticipants();
  await press(followButton(who.id));
  return socket;
}

const update = (socket: FakeWebSocket, x: number, y: number, zoom: number, id = sam.id) => server(socket, { data: { type: "viewportUpdate", id, x, y, zoom } });

describe("Follow in Participants", () => {
  it("a Follow button beside Go to for each other person, never for me; names as text", async () => {
    await inRoom({ others: [sam, jo] });
    await openParticipants();
    expect(followButton(sam.id)?.textContent).toContain("Follow");
    expect(followButton(sam.id)?.getAttribute("aria-label")).toBe("Follow Sam");
    expect(followButton(jo.id)).not.toBeNull();
    expect(followButton(alex.id)).toBeNull();
    expect(document.querySelectorAll("[data-follow]")).toHaveLength(2);
    // Beside Go to, in the same row.
    expect(followButton(sam.id)?.closest("li")?.querySelector(`[data-goto="${sam.id}"]`)).not.toBeNull();
  });

  it("Follow sends followStart, closes the sheet and shows the waiting chip; the button then says Stop following", async () => {
    const socket = await following();
    expect(socket.ofType("followStart")).toEqual([{ type: "followStart", target: sam.id }]);
    expect(window.location.hash).toMatch(/^#\/room\//);
    expect(chip()?.textContent).toContain("Waiting for Sam’s view.");
    expect(chip()?.textContent).toContain("Phones and hidden tabs don’t share a view.");
    await openParticipants();
    expect(followButton(sam.id)?.textContent).toContain("Stop following");
    expect(followButton(sam.id)?.getAttribute("aria-label")).toBe("Stop following Sam");
    await press(followButton(sam.id));
    expect(socket.ofType("followStop")).toHaveLength(1);
    expect(chip()).toBeNull();
  });

  it("phones have it too (they can follow; they just never send their own view)", async () => {
    const socket = await following({ isWide: false });
    expect(socket.ofType("followStart")).toHaveLength(1);
    expect(chip()).not.toBeNull();
  });
});

describe("while following", () => {
  it("the view moves to the leader's view; the chip says Following Sam; that move isn't mine (no followStop)", async () => {
    setReducedMotion(true);
    const socket = await following();
    await update(socket, 1000, 800, 1);
    await settle();
    expect(transform()).toEqual(centredOn(1000, 800, 1));
    expect(chip()?.textContent).toContain("Following Sam");
    expect(chip()?.textContent).not.toContain("Waiting");
    await update(socket, 1200, 900, 0.5);
    await settle();
    expect(transform()).toEqual(centredOn(1200, 900, 0.5));
    expect(socket.ofType("followStop")).toEqual([]);
    expect(chip()).not.toBeNull();
  });

  it("someone else's update (an earlier follow) is ignored", async () => {
    setReducedMotion(true);
    const socket = await following();
    const before = transform();
    await update(socket, 1000, 800, 1, jo.id);
    expect(transform()).toEqual(before);
  });

  it("the Stop button (a full touch target) stops it and says so once", async () => {
    const socket = await following();
    const stop = stopButton();
    expect(stop?.textContent).toContain("Stop");
    expect(stop?.className).toContain("h-touch");
    await press(stop);
    expect(socket.ofType("followStop")).toHaveLength(1);
    expect(chip()).toBeNull();
    expect(notice()?.textContent).toBe("Stopped following Sam.");
    expect(announcer()?.textContent).toBe("Stopped following Sam.");
  });

  it.each([
    ["+ (zoom in)", "+"],
    ["- (zoom out)", "-"],
    ["0 (100%)", "0"],
    ["F (fit)", "f"],
  ])("my own zoom or pan stops it: %s", async (_, k) => {
    setReducedMotion(true);
    const socket = await following();
    await update(socket, 1000, 800, 1);
    await key(k);
    expect(socket.ofType("followStop")).toHaveLength(1);
    expect(chip()).toBeNull();
    expect(announcer()?.textContent).toBe("Stopped following Sam.");
    // Later updates (already on their way) don't move the view any more.
    const after = transform();
    await update(socket, 2000, 1500, 1);
    expect(transform()).toEqual(after);
  });

  it("a press on the overview map stops it", async () => {
    const socket = await following();
    const minimap = q(".react-flow__minimap");
    expect(minimap).not.toBeNull();
    await act(async () => minimap?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 5, clientY: 5 })));
    await settle();
    expect(socket.ofType("followStop")).toHaveLength(1);
  });

  it("Go to a person stops it", async () => {
    setReducedMotion(true);
    const socket = await following();
    await server(socket, { data: { type: "cursorMoved", id: jo.id, x: 300, y: 300 } });
    await openParticipants();
    await press(q(`[data-goto="${jo.id}"]`));
    await settle();
    expect(socket.ofType("followStop")).toHaveLength(1);
  });

  it("following someone else replaces it (one followStart each, no followStop)", async () => {
    const socket = await following();
    await openParticipants();
    await press(followButton(jo.id));
    expect(socket.ofType("followStart")).toEqual([
      { type: "followStart", target: sam.id },
      { type: "followStart", target: jo.id },
    ]);
    expect(socket.ofType("followStop")).toEqual([]);
    expect(chip()?.textContent).toContain("Waiting for Jo’s view.");
  });

  it("the announcer says the start once and nothing for a stream of updates", async () => {
    setReducedMotion(true);
    const socket = await following();
    expect(announcer()?.getAttribute("aria-live")).toBe("polite");
    expect(announcer()?.textContent).toBe("Following Sam. Pan or zoom to stop.");
    const writes: string[] = [];
    const observer = new MutationObserver(() => writes.push(announcer()?.textContent ?? ""));
    observer.observe(announcer()!, { childList: true, characterData: true, subtree: true });
    for (let i = 0; i < 5; i++) await update(socket, 1000 + i * 50, 800, 1);
    await settle();
    observer.disconnect();
    expect(writes).toEqual([]);
    // The chip itself isn't a live region.
    expect(chip()?.closest("[aria-live]")).toBeNull();
  });
});

describe("followEnded and a refused follow", () => {
  it("target_left: '<name> left.' and the chip goes", async () => {
    const socket = await following();
    await server(socket, { data: { type: "followEnded", reason: "target_left" } });
    expect(chip()).toBeNull();
    expect(notice()?.textContent).toBe("Sam left.");
    expect(announcer()?.textContent).toBe("Sam left.");
  });

  it("not_found: 'That person isn't here.'", async () => {
    const socket = await following();
    await server(socket, { data: { type: "followEnded", reason: "not_found" } });
    expect(chip()).toBeNull();
    expect(notice()?.textContent).toBe("That person isn’t here.");
  });

  it("followers_full: '<name> already has 10 people following.' and I follow nobody", async () => {
    const socket = await following();
    await server(socket, { data: { type: "error", code: "followers_full", message: "Full." } });
    expect(chip()).toBeNull();
    expect(notice()?.textContent).toBe("Sam already has 10 people following.");
    await openParticipants();
    expect(followButton(sam.id)?.textContent).not.toContain("Stop following");
  });
});

describe("N following you", () => {
  it("from md up: a plain count while anyone follows me, gone at 0; never names, never announced", async () => {
    const socket = await inRoom();
    expect(followers()).toBeNull();
    await server(socket, { data: { type: "followersChanged", count: 2 } });
    expect(followers()?.textContent).toBe("2 following you");
    expect(followers()?.closest("[aria-live]")).toBeNull();
    expect(followers()?.textContent).not.toContain("Sam");
    await server(socket, { data: { type: "followersChanged", count: 0 } });
    expect(followers()).toBeNull();
  });

  it("phones show nothing (they never send their view)", async () => {
    const socket = await inRoom({ isWide: false });
    await server(socket, { data: { type: "followersChanged", count: 2 } });
    expect(followers()).toBeNull();
  });

  it("a followed page sends its view when it moves; a phone never does", async () => {
    setReducedMotion(true);
    const socket = await inRoom();
    await server(socket, { data: { type: "followersChanged", count: 1 } });
    await key("+");
    await settle();
    const sent = socket.ofType("viewport");
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.at(-1)).toMatchObject({ type: "viewport", zoom: expect.any(Number) });
  });

  it("a phone never sends its view, even followed", async () => {
    setReducedMotion(true);
    const socket = await inRoom({ isWide: false });
    await server(socket, { data: { type: "followersChanged", count: 1 } });
    await key("+");
    await settle();
    expect(socket.ofType("viewport")).toEqual([]);
  });
});

describe("Bring to me (host)", () => {
  it("guests don't get it", async () => {
    await inRoom();
    expect(bring()).toBeNull();
    await openParticipants();
    expect(bring()).toBeNull();
  });

  it("in the board bar's Session group from md up: sends my view once, then off for 5 seconds with the reason", async () => {
    const socket = await inRoom({ host: true });
    const b = bring();
    expect(b).not.toBeNull();
    expect(boardBar()?.contains(b)).toBe(true);
    expect(b?.getAttribute("aria-disabled")).toBeNull();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await press(b);
    expect(socket.ofType("bringToMe")).toHaveLength(1);
    expect(socket.ofType("bringToMe")[0]).toMatchObject({ type: "bringToMe", x: expect.any(Number), y: expect.any(Number), zoom: expect.any(Number) });
    expect(bring()?.getAttribute("aria-disabled")).toBe("true");
    expect(tipOf(bring())?.textContent).toContain("Wait a few seconds.");
    expect(announcer()?.textContent).toBe("Asked everyone to come to your view.");
    // Never inside the window.
    await press(bring());
    expect(socket.ofType("bringToMe")).toHaveLength(1);
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    await settle();
    expect(bring()?.getAttribute("aria-disabled")).toBeNull();
    await press(bring());
    expect(socket.ofType("bringToMe")).toHaveLength(2);
  });

  it("on phones, in the Participants sheet's Session section, with the reason as text", async () => {
    const socket = await inRoom({ host: true, isWide: false });
    await openParticipants();
    const b = bring();
    expect(b?.closest("section")?.querySelector("#session-heading")).not.toBeNull();
    await press(b);
    expect(socket.ofType("bringToMe")).toHaveLength(1);
    expect(q("[data-bring-reason]")?.textContent).toBe("Wait a few seconds.");
    expect(q("[data-bring-sent]")?.textContent).toBe("Asked everyone to come to your view.");
  });

  it("works on a locked board and during a silent round", async () => {
    const socket = await inRoom({ host: true, locked: true, silent: { active: true, count: 0 } });
    await press(bring());
    expect(socket.ofType("bringToMe")).toHaveLength(1);
  });

  it("off with the reason while not connected", async () => {
    const socket = await inRoom({ host: true, isWide: false });
    await server(socket, "close");
    await openParticipants();
    // The Session section is only for a live host; when it shows, the button says why it's off.
    const b = bring();
    if (b) {
      expect(b.getAttribute("aria-disabled")).toBe("true");
      expect(q("[data-bring-reason]")?.textContent).toBe("Not connected.");
      await press(b);
    }
    expect(socket.ofType("bringToMe")).toEqual([]);
  });
});

describe("the Bring to me banner", () => {
  const brought = (socket: FakeWebSocket, x = 1500, y = 1000, zoom = 0.75, from = hostSam.id) =>
    server(socket, { data: { type: "broughtToMe", from, x, y, zoom } });

  it("says who asked, as a polite status; never moves the view or steals focus by itself", async () => {
    setReducedMotion(true);
    const socket = await inRoom({ others: [hostSam, jo] });
    const before = transform();
    const focused = document.activeElement;
    await brought(socket);
    expect(bannerText()?.textContent).toBe("Sam asked everyone to come to their view");
    expect(bannerText()?.getAttribute("role")).toBe("status");
    expect(bannerText()?.getAttribute("aria-live")).toBe("polite");
    expect(transform()).toEqual(before);
    expect(document.activeElement).toBe(focused);
    expect(goThere()?.className).toContain("h-touch");
  });

  it("Go there moves to the sent view and dismisses", async () => {
    setReducedMotion(true);
    const socket = await inRoom({ others: [hostSam, jo] });
    await brought(socket, 1500, 1000, 0.5);
    await press(goThere());
    await settle();
    expect(transform()).toEqual(centredOn(1500, 1000, 0.5));
    expect(banner()).toBeNull();
  });

  it("Dismiss and Escape dismiss it", async () => {
    const socket = await inRoom({ others: [hostSam, jo] });
    await brought(socket);
    await press(dismiss());
    expect(banner()).toBeNull();
    await brought(socket);
    expect(banner()).not.toBeNull();
    await key("Escape", document.body);
    expect(banner()).toBeNull();
  });

  it("a newer one replaces the older (one banner)", async () => {
    setReducedMotion(true);
    const socket = await inRoom({ others: [hostSam, jo] });
    await brought(socket, 100, 100, 1);
    await brought(socket, 1500, 1000, 0.5);
    expect(document.querySelectorAll("[data-brought-banner]")).toHaveLength(1);
    await press(goThere());
    expect(transform()).toEqual(centredOn(1500, 1000, 0.5));
  });

  it("goes by itself after a minute", async () => {
    const socket = await inRoom({ others: [hostSam, jo] });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await brought(socket);
    await act(async () => {
      vi.advanceTimersByTime(59_000);
    });
    expect(banner()).not.toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(1_500);
    });
    await settle();
    expect(banner()).toBeNull();
  });

  it("while following: the banner says Go there stops following; Go there does, and says so", async () => {
    setReducedMotion(true);
    const socket = await following({ others: [hostSam, jo] }, jo);
    await brought(socket);
    expect(banner()?.textContent).toContain("Go there stops following Jo.");
    await press(goThere());
    expect(socket.ofType("followStop")).toHaveLength(1);
    expect(chip()).toBeNull();
    expect(announcer()?.textContent).toBe("Stopped following Jo.");
    // Go there's own move doesn't count as mine twice (one followStop).
    expect(socket.ofType("followStop")).toHaveLength(1);
  });

  it("phones show it and Go there too", async () => {
    setReducedMotion(true);
    const socket = await inRoom({ isWide: false, others: [hostSam, jo] });
    await brought(socket, 1500, 1000, 0.5);
    expect(banner()).not.toBeNull();
    await press(goThere());
    expect(transform()).toEqual(centredOn(1500, 1000, 0.5));
  });
});

describe("resets", () => {
  it("a drop clears the chip and banner; the reconnected page follows nobody", async () => {
    const socket = await following({ others: [hostSam, jo] }, jo);
    await server(socket, { data: { type: "broughtToMe", from: hostSam.id, x: 1, y: 1, zoom: 1 } });
    expect(chip()).not.toBeNull();
    expect(banner()).not.toBeNull();
    await server(socket, "close");
    expect(chip()).toBeNull();
    expect(banner()).toBeNull();
    // Reconnect: a new socket, joined again.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1300));
    });
    const next = lastSocket();
    if (next !== socket) {
      await server(next, "open");
      await server(next, { data: { type: "welcome", protocolVersion: PROTOCOL_VERSION } });
      await server(next, {
        data: { type: "joined", you: { ...alex, id: "DDDDDDDDDDDDDDDD" }, participants: [{ ...alex, id: "DDDDDDDDDDDDDDDD" }, hostSam, jo], locked: false, timer: null, voting: { state: "off", budget: 5, round: 0 }, silent: { active: false, count: 0 } },
      });
      await server(next, { data: { type: "snapshot", notes: [] } });
      expect(chip()).toBeNull();
      expect(banner()).toBeNull();
      expect(next.ofType("followStart")).toEqual([]);
    }
  });

  it("a host's End session clears them", async () => {
    const socket = await following({ others: [hostSam, jo] }, jo);
    await server(socket, { data: { type: "followEnded", reason: "target_left" } });
    await server(socket, { data: { type: "sessionEnded" } });
    expect(chip()).toBeNull();
    expect(banner()).toBeNull();
  });
});

describe("untrusted names", () => {
  // "<img src=x onerror=alert(1)>" is 28 characters, over the 24-character name limit (the relay
  // would never send it); the same payload within the limit.
  const evil: Participant = { id: "EEEEEEEEEEEEEEEE", name: "<img src=x onerror=a()>", colourIndex: 3, host: true };

  it("render as text in the button, the chip, the notices and the banner", async () => {
    const socket = await following({ others: [evil, jo] }, evil);
    expect(chip()?.textContent).toContain("<img src=x oner…");
    await server(socket, { data: { type: "broughtToMe", from: evil.id, x: 1, y: 1, zoom: 1 } });
    expect(bannerText()?.textContent).toBe("<img src=x oner… asked everyone to come to their view");
    await server(socket, { data: { type: "followEnded", reason: "target_left" } });
    expect(notice()?.textContent).toBe("<img src=x oner… left.");
    await openParticipants();
    expect(followButton(evil.id)?.getAttribute("aria-label")).toBe("Follow <img src=x oner…");
    expect(document.querySelector("img")).toBeNull();
  });
});

describe("storage", () => {
  it("following, notices, Bring to me and the banner write nothing to browser storage", async () => {
    const socket = await inRoom({ host: true, others: [sam, jo] });
    const set = vi.spyOn(Storage.prototype, "setItem");
    await openParticipants();
    await press(followButton(sam.id));
    await update(socket, 100, 100, 1);
    await press(stopButton());
    await press(bring());
    await server(socket, { data: { type: "followersChanged", count: 1 } });
    expect(set).not.toHaveBeenCalled();
  });
});
