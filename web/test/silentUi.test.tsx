// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_SEALED_PER_WRITER } from "@stickyard/shared";
import { CLEAR_HINTS, clearBoardReason } from "../src/properties/clearBoard";
import { HOST_VOTE_HINTS, hostVoteReasons } from "../src/voting/voting";
import { SILENT_TEXT, silentNoteReason, withSilent } from "../src/silent/silent";
import { alex, boardBar, cleanupUi, frameAt, inRoom, installUi, isOff, noteAt, notesShown, selectNote, settle, tipOf } from "./helpers/ui";

/*
 * Silent brainstorm, part 2 (web only): while a round runs, what the relay would refuse is off with
 * a visible reason, never hidden: Clear board, moving frames, starting a vote; Export is off too;
 * vote controls are absent on my sealed notes; Add note says why at the writer cap.
 */

const properties = () => document.querySelector<HTMLElement>('aside[aria-label="Properties"]');
const palette = () => document.querySelector<HTMLElement>('aside[aria-label="Palette"]');
const exportSection = () => document.querySelector<HTMLElement>("[data-export-section]");
const ACTIVE = { active: true, count: 3 };

beforeEach(installUi);
afterEach(cleanupUi);

describe("rules (pure)", () => {
  it("withSilent: a control's own reason first, then the round (only while connected)", () => {
    expect(withSilent(null, { live: true, active: true })).toBe(SILENT_TEXT.on);
    expect(withSilent("Not connected.", { live: false, active: true })).toBe("Not connected.");
    expect(withSilent(null, { live: true, active: false })).toBeNull();
    expect(withSilent(CLEAR_HINTS.busy, { live: true, active: true })).toBe(CLEAR_HINTS.busy);
  });

  it("Clear board: off while a round runs", () => {
    expect(clearBoardReason({ live: true, notes: 3, frames: 0, busy: false, clearing: false, silent: true })).toBe(SILENT_TEXT.on);
    expect(clearBoardReason({ live: false, notes: 3, frames: 0, busy: false, clearing: false, silent: true })).toBe(CLEAR_HINTS.offline);
  });

  it("Start voting: off while a round runs; Stop and Clear stay as they were", () => {
    expect(hostVoteReasons({ blocked: null, state: "off", silent: true })).toEqual({ start: SILENT_TEXT.on, stop: HOST_VOTE_HINTS.notOpen, clear: HOST_VOTE_HINTS.nothing });
    expect(hostVoteReasons({ blocked: null, state: "open", silent: true }).stop).toBeNull();
  });

  it("Add note: no writer, or my notes at the cap, say why", () => {
    expect(silentNoteReason({ active: true, writer: false, mine: 0 })).toBe(SILENT_TEXT.noWriter);
    expect(silentNoteReason({ active: true, writer: true, mine: MAX_SEALED_PER_WRITER })).toBe(SILENT_TEXT.writerFull);
    expect(silentNoteReason({ active: true, writer: true, mine: MAX_SEALED_PER_WRITER - 1 })).toBeNull();
    expect(silentNoteReason({ active: false, writer: false, mine: 99 })).toBeNull();
  });

  it("the texts are plain and polite", () => {
    expect(SILENT_TEXT.on).toBe("Silent brainstorm is on.");
    expect(SILENT_TEXT.export).toBe("Export is off during a silent round.");
    expect(SILENT_TEXT.writerFull).toBe("You’ve written the most notes you can in this round.");
  });
});

describe("while a round runs", () => {
  it("Clear board is off with the reason as visible text", async () => {
    await inRoom({ notes: [noteAt(1)], silent: ACTIVE, mine: [] });
    const clear = [...(properties()?.querySelectorAll("button") ?? [])].find((b) => b.textContent?.includes("Clear board"));
    expect(isOff(clear)).toBe(true);
    expect(properties()?.textContent).toContain(SILENT_TEXT.on);
  });

  it("Export PNG and Export Markdown are off with the reason as visible text", async () => {
    await inRoom({ notes: [noteAt(1)], silent: ACTIVE, mine: [] });
    for (const kind of ["png", "md"]) expect(isOff(exportSection()?.querySelector(`[data-export="${kind}"]`))).toBe(true);
    expect(exportSection()?.textContent).toContain(SILENT_TEXT.export);
  });

  it("with no round, Clear board and Export work as before", async () => {
    await inRoom({ notes: [noteAt(1)] });
    expect(isOff(exportSection()?.querySelector('[data-export="png"]'))).toBe(false);
    expect(properties()?.textContent).not.toContain(SILENT_TEXT.on);
  });

  it("frames: Align and Distribute are off with the reason (in the tooltip and as text in Arrange); Match size stays", async () => {
    await inRoom({ frames: [frameAt(0), frameAt(1), frameAt(2)], silent: ACTIVE, mine: [] });
    for (let i = 0; i < 3; i++) {
      const header = document.querySelectorAll<HTMLElement>("[data-frame-id]")[i]?.querySelector<HTMLElement>("[data-frame-handle='header']");
      await act(async () => header?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, shiftKey: i > 0 })));
      await settle();
    }
    const barButton = (label: string) => boardBar()?.querySelector<HTMLElement>(`[aria-label="${label}"]`) ?? null;
    for (const label of ["Align left edges", "Distribute horizontally (equal gaps)"]) {
      expect(isOff(barButton(label)), label).toBe(true);
      expect(tipOf(barButton(label))?.textContent, label).toBe(SILENT_TEXT.on);
    }
    expect(isOff(barButton("Match width to the first selected"))).toBe(false);
    expect(document.querySelector("[data-arrange-reason]")?.textContent).toBe(SILENT_TEXT.on);
  });

  it("at my cap, the note tiles are off with the reason", async () => {
    // 16-character ids, laid out in rows of ten.
    const ids = Array.from({ length: MAX_SEALED_PER_WRITER }, (_, i) =>
      noteAt(i, { id: `S${String(i).padStart(15, "0")}`, x: 40 + (i % 10) * 220, y: 60 + Math.floor(i / 10) * 220, authorId: alex.id }),
    );
    await inRoom({ notes: ids, silent: { active: true, count: MAX_SEALED_PER_WRITER }, mine: ids.map((n) => n.id) });
    const tile = palette()?.querySelector<HTMLButtonElement>('[data-palette-item="note-yellow"]');
    expect(tile?.disabled).toBe(true);
    expect(tile?.title).toContain(SILENT_TEXT.writerFull);
  }, 20_000);

  it("vote controls and the Votes section are absent on my sealed note, there on a note everyone sees", async () => {
    await inRoom({
      notes: [noteAt(1), noteAt(2, { authorId: alex.id })],
      silent: { active: true, count: 1 },
      mine: [noteAt(2).id],
      voting: { state: "open", budget: 5, round: 1 },
    });
    await selectNote(1);
    expect(document.querySelector("[data-vote-controls]")).toBeNull();
    expect(properties()?.querySelector("[data-votes-section]")).toBeNull();
    await selectNote(0);
    expect(notesShown()).toHaveLength(2);
    expect(properties()?.querySelector("[data-votes-section]")).not.toBeNull();
  });
});
