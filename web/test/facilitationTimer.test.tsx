// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TIMER_TEXT } from "../src/timer/timer";
import { button, chip, cleanupUi, click, inRoom, input, installUi, named, server, setReducedMotion, settle, submit, timerAnnouncer, type } from "./helpers/ui";

/*
 * Facilitation UI, part 1: the room timer. Everyone sees a chip while a timer exists, counting
 * down by the relay's clock; only the host gets controls (palette tile + picker from md up,
 * Stop/Restart on the chip; on phones a Session section in the Participants sheet).
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = 2_000_000_000_000;
const timer = (durationMs: number, startedAt = NOW, serverNow = NOW) => ({ startedAt, durationMs, serverNow });

/** Moves this device's clock and lets the page recompute (as when a tab becomes visible again). */
async function at(ms: number) {
  vi.setSystemTime(NOW + ms);
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  await settle();
}

const palette = () => document.querySelector<HTMLElement>('aside[aria-label="Palette"]');
const timerTile = () => palette()?.querySelector<HTMLButtonElement>('[data-palette-item="timer"]') ?? null;
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');

beforeEach(() => {
  installUi();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(async () => {
  await cleanupUi();
  vi.useRealTimers();
});

describe("the chip (everyone)", () => {
  it("appears when a timer starts, counts down as mm:ss and announces the start once", async () => {
    const socket = await inRoom();
    expect(chip()).toBeNull();
    await server(socket, { data: { type: "timerChanged", timer: timer(300_000) } });
    expect(chip()?.textContent).toContain("05:00");
    expect(chip()?.closest("header")).not.toBeNull();
    expect(timerAnnouncer()?.textContent).toBe("Timer started: 5 minutes.");
    expect(timerAnnouncer()?.getAttribute("aria-live")).toBe("polite");
    await at(61_000);
    expect(chip()?.textContent).toContain("03:59");
    // Ticks aren't announced: the live region keeps its text.
    expect(timerAnnouncer()?.textContent).toBe("Timer started: 5 minutes.");
    // The countdown itself isn't a live region.
    expect(chip()?.querySelector("[aria-live]")).toBeNull();
  });

  it("uses the relay's clock: a device 30 s behind still shows the right time", async () => {
    const socket = await inRoom();
    await server(socket, { data: { type: "timerChanged", timer: timer(300_000, NOW + 30_000, NOW + 30_000) } });
    expect(chip()?.textContent).toContain("05:00");
    await at(60_000);
    expect(chip()?.textContent).toContain("04:00");
  });

  it("is right after a long gap with no ticks (a throttled background tab)", async () => {
    const socket = await inRoom();
    await server(socket, { data: { type: "timerChanged", timer: timer(3_600_000) } });
    expect(chip()?.textContent).toContain("1:00:00");
    await at(1_234_000);
    expect(chip()?.textContent).toContain("39:26");
  });

  it("the last minute: a text cue and a style change, announced once; then Time's up", async () => {
    const socket = await inRoom();
    await server(socket, { data: { type: "timerChanged", timer: timer(120_000) } });
    expect(chip()?.dataset.phase).toBe("running");
    await at(70_000);
    expect(chip()?.dataset.phase).toBe("final");
    expect(chip()?.textContent).toContain("Last minute");
    expect(chip()?.textContent).toContain("00:50");
    expect(timerAnnouncer()?.textContent).toBe(TIMER_TEXT.lastMinute);
    await at(120_000);
    expect(chip()?.dataset.phase).toBe("finished");
    expect(chip()?.textContent).toContain("Time’s up");
    expect(timerAnnouncer()?.textContent).toBe(TIMER_TEXT.finished);
    // It stays for 10 minutes after the end, then hides here.
    await at(120_000 + 9 * 60_000);
    expect(chip()).not.toBeNull();
    await at(120_000 + 10 * 60_000);
    expect(chip()).toBeNull();
  });

  it("goes when the host stops it", async () => {
    const socket = await inRoom();
    await server(socket, { data: { type: "timerChanged", timer: timer(300_000) } });
    await server(socket, { data: { type: "timerChanged", timer: null } });
    expect(chip()).toBeNull();
  });

  it("a timer already running is shown on joining", async () => {
    await inRoom({ timer: timer(600_000, NOW - 60_000) });
    expect(chip()?.textContent).toContain("09:00");
  });

  it("never animates (and so nothing pulses under reduced motion either)", async () => {
    setReducedMotion(true);
    const socket = await inRoom();
    await server(socket, { data: { type: "timerChanged", timer: timer(30_000) } });
    const classes = [chip(), ...(chip()?.querySelectorAll("*") ?? [])].map((el) => String(el?.getAttribute("class") ?? "")).join(" ");
    expect(classes).not.toMatch(/animate-|sy-pulse|transition/);
  });

  it("a guest sees no controls: no Stop or Restart, no Timer tile", async () => {
    const socket = await inRoom();
    await server(socket, { data: { type: "timerChanged", timer: timer(300_000) } });
    expect(named("Stop timer", chip() ?? document)).toBeUndefined();
    expect(named("Restart timer", chip() ?? document)).toBeUndefined();
    expect(timerTile()).toBeNull();
    expect(palette()?.textContent).not.toContain("Facilitation");
  });
});

describe("host controls (md and up)", () => {
  it("a Timer tile under Facilitation opens the picker; a preset starts it", async () => {
    const socket = await inRoom({ host: true });
    expect(palette()?.textContent).toContain("Facilitation");
    await click(timerTile());
    expect(dialog()?.querySelector("h2")?.textContent).toBe("Start a timer");
    for (const label of ["1 minute", "3 minutes", "5 minutes", "10 minutes", "15 minutes", "30 minutes"]) {
      expect(button(label, dialog() ?? document), label).toBeDefined();
    }
    await click(button("5 minutes", dialog() ?? document));
    expect(socket.ofType("timerStart")).toEqual([{ type: "timerStart", durationMs: 300_000 }]);
    expect(dialog()).toBeNull();
  });

  it("custom minutes: refused with a clear message outside 1 second to 3 hours, nothing sent; a good value starts it", async () => {
    const socket = await inRoom({ host: true });
    await click(timerTile());
    const field = input("Minutes");
    await type(field, "abc");
    await submit(field);
    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toBe(TIMER_TEXT.notNumber);
    await type(field, "181");
    await submit(field);
    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toBe(TIMER_TEXT.outOfRange);
    expect(socket.ofType("timerStart")).toEqual([]);
    await type(field, "2.5");
    await submit(field);
    expect(socket.ofType("timerStart")).toEqual([{ type: "timerStart", durationMs: 150_000 }]);
  });

  it("starting while one runs says it replaces it", async () => {
    const socket = await inRoom({ host: true });
    await server(socket, { data: { type: "timerChanged", timer: timer(300_000) } });
    await click(timerTile());
    expect(dialog()?.textContent).toContain(TIMER_TEXT.replaces);
  });

  it("the chip has Restart and Stop; Stop asks first only with more than a minute left", async () => {
    const socket = await inRoom({ host: true });
    await server(socket, { data: { type: "timerChanged", timer: timer(300_000) } });
    await click(named("Restart timer", chip() ?? document));
    expect(socket.ofType("timerStart")).toEqual([{ type: "timerStart", durationMs: 300_000 }]);
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    await click(named("Stop timer", chip() ?? document));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(socket.ofType("timerStop")).toEqual([]);
    confirm.mockReturnValue(true);
    await click(named("Stop timer", chip() ?? document));
    expect(socket.ofType("timerStop")).toEqual([{ type: "timerStop" }]);
    // Under a minute left: no question.
    await at(250_000);
    confirm.mockClear();
    await click(named("Stop timer", chip() ?? document));
    expect(confirm).not.toHaveBeenCalled();
    expect(socket.ofType("timerStop")).toHaveLength(2);
  });

  it("disconnected: the tile and the chip's buttons are off and say why", async () => {
    const socket = await inRoom({ host: true });
    await server(socket, { data: { type: "timerChanged", timer: timer(300_000) } });
    await server(socket, "close");
    expect(timerTile()?.disabled).toBe(true);
    expect(timerTile()?.title).toContain("Not connected.");
    expect(named("Stop timer", chip() ?? document)?.getAttribute("aria-disabled")).toBe("true");
  });
});

describe("phones", () => {
  it("everyone gets a compact chip in the top bar, without controls", async () => {
    const socket = await inRoom({ host: true, isWide: false });
    await server(socket, { data: { type: "timerChanged", timer: timer(300_000) } });
    expect(chip()?.closest("header")).not.toBeNull();
    expect(chip()?.dataset.compact).toBe("true");
    expect(named("Stop timer", chip() ?? document)).toBeUndefined();
  });

  it("the host's timer controls are in the Participants sheet's Session section", async () => {
    const socket = await inRoom({ host: true, isWide: false });
    await click(document.querySelector<HTMLElement>('header [aria-label^="Participants"]'));
    const session = document.querySelector<HTMLElement>('[role="dialog"] section[aria-labelledby="session-heading"]');
    expect(session?.querySelector("h3")?.textContent).toBe("Session");
    // The same presets and minutes field, inline (no second sheet over this one).
    await click(button("3 minutes", session ?? document));
    expect(socket.ofType("timerStart")).toEqual([{ type: "timerStart", durationMs: 180_000 }]);
  });

  it("a guest's Participants sheet has no Session section", async () => {
    await inRoom({ isWide: false });
    await click(document.querySelector<HTMLElement>('header [aria-label^="Participants"]'));
    expect(document.querySelector('[role="dialog"] section[aria-labelledby="session-heading"]')).toBeNull();
  });
});
