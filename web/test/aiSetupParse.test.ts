import { describe, expect, it } from "vitest";
import { FRAME_MAX_W, FRAME_MIN_H, MAX_FRAME_TITLE, NOTE_DEFAULTS } from "@stickyard/shared";
import { SETUP_LIMITS } from "../src/ai/setupPrompt";
import { SETUP_WARNINGS, parseSetupReply, type SetupResult } from "../src/ai/setupParse";
import { parseStencil } from "../src/stencils/data";
import { RETRO_REPLY } from "./helpers/aiSetupFake";

/*
 * Board setup from a prompt (10b, v0.43.0): the reply is untrusted data. Code fences stripped,
 * JSON.parse, then the board-file item checks plus the caps. Fixable problems are fixed and listed;
 * anything unreadable is one clean error. A bad layout is re-done by a fixed rule, never refused.
 */

const ROOMY = { notes: 200, frames: 30 };
const ok = (reply: unknown, free = ROOMY): SetupResult => {
  const r = parseSetupReply(typeof reply === "string" ? reply : JSON.stringify(reply), free);
  if (!r.ok) throw new Error("expected a board");
  return r.result;
};
const frameNote = (text: string, frame: string | null, x: number | null = null, y: number | null = null, color = "yellow") => ({ text, color, frame, x, y });
const aFrame = (ref: string, x: number | null = null, y: number | null = null, extra: Record<string, unknown> = {}) => ({ ref, title: ref.toUpperCase(), color: "neutral", x, y, w: 640, h: 400, ...extra });

type Rect = { x: number; y: number; w: number; h: number };
const overlap = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const inside = (n: Rect, f: Rect) => n.x >= f.x && n.y >= f.y && n.x + n.w <= f.x + f.w && n.y + n.h <= f.y + f.h;

/** Every frame's notes inside it, loose notes outside every frame, nothing overlapping. */
function expectTidy(result: SetupResult) {
  const { frames, notes } = result.content;
  for (let i = 0; i < frames.length; i++) for (let j = i + 1; j < frames.length; j++) expect(overlap(frames[i]!, frames[j]!)).toBe(false);
  for (let i = 0; i < notes.length; i++) for (let j = i + 1; j < notes.length; j++) expect(overlap(notes[i]!, notes[j]!)).toBe(false);
  for (const pf of result.frames) {
    const f = frames.find((x) => x.ref === pf.ref)!;
    for (const pn of pf.notes) expect(inside(notes.find((n) => n.ref === pn.ref)!, f)).toBe(true);
  }
  for (const pn of result.loose) for (const f of frames) expect(overlap(notes.find((n) => n.ref === pn.ref)!, f)).toBe(false);
}

describe("reading the reply", () => {
  it("a good reply: frames with their notes, loose notes, counts, nothing to warn about, the model's layout kept", () => {
    const r = ok(RETRO_REPLY);
    expect(r.frames.map((f) => [f.title, f.color, f.notes.map((n) => n.text)])).toEqual([
      ["Went well", "green", ["Shipped on time", "Good pairing"]],
      ["To improve", "pink", ["Fewer meetings", "Clearer tickets"]],
      ["Actions", "blue", ["Book a demo slot"]],
    ]);
    expect(r.loose.map((n) => n.text)).toEqual(["Parking lot"]);
    expect(r.warnings).toEqual([]);
    expect(r.relaidOut).toBe(false);
    expect(r.content.frames.map((f) => [f.x, f.y, f.w, f.h])).toEqual([
      [0, 0, 640, 440],
      [720, 0, 640, 440],
      [1440, 0, 640, 440],
    ]);
    expect(r.content.notes[0]).toMatchObject({ x: 24, y: 72, ...NOTE_DEFAULTS, color: "green", text: "Shipped on time" });
    expectTidy(r);
    // The content is a stencil the board places like Import (it passes the stencil parser unchanged).
    const { stack, cut, ...stencil } = r.content;
    expect(parseStencil(stencil)).toEqual(stencil);
    expect(stack).toEqual(r.content.notes.map((n) => n.ref));
    expect(cut).toBe(0);
  });

  it("strips code fences around the JSON", () => {
    expect(ok("```json\n" + JSON.stringify(RETRO_REPLY) + "\n```").frames).toHaveLength(3);
    expect(ok("```\n" + JSON.stringify(RETRO_REPLY) + "```").frames).toHaveLength(3);
  });

  it("puts the top-left at 0, 0 whatever the model's origin", () => {
    const r = ok({ frames: [aFrame("a", 500, 300)], notes: [frameNote("x", "a", 524, 372)] });
    expect(r.content.frames[0]).toMatchObject({ x: 0, y: 0 });
    expect(r.content.notes[0]).toMatchObject({ x: 24, y: 72 });
  });

  it.each([
    ["not JSON", "Here is your board: Went well, To improve"],
    ["a list", "[]"],
    ["a number", "42"],
    ["frames not a list", JSON.stringify({ frames: 3, notes: [] })],
    ["notes not a list", JSON.stringify({ frames: [], notes: "a" })],
    ["no items", JSON.stringify({ frames: [], notes: [] })],
    ["nothing readable", JSON.stringify({ frames: [1, "x"], notes: [null, { color: "pink" }] })],
    ["empty", ""],
  ])("is unreadable: %s", (_name, text) => {
    expect(parseSetupReply(text, ROOMY)).toEqual({ ok: false, reason: "unreadable" });
  });
});

describe("fix-ups (each fixed and listed)", () => {
  it("an unknown colour drops to the default (yellow notes, neutral frames)", () => {
    const r = ok({ frames: [aFrame("a", null, null, { color: "teal" })], notes: [frameNote("x", "a", null, null, "magenta"), frameNote("y", null, null, null, "pink")] });
    expect(r.content.frames[0]!.color).toBe("neutral");
    expect(r.content.notes.map((n) => n.color)).toEqual(["yellow", "pink"]);
    expect(r.warnings).toContain(SETUP_WARNINGS.colour(2));
  });

  it("over-long text is cut: notes to 140 characters, frame titles to 60", () => {
    const r = ok({ frames: [aFrame("a", null, null, { title: "T".repeat(90) })], notes: [frameNote("é".repeat(200), "a")] });
    expect([...r.content.notes[0]!.text]).toHaveLength(SETUP_LIMITS.noteText);
    expect(r.content.frames[0]!.title).toHaveLength(MAX_FRAME_TITLE);
    expect(r.warnings).toContain(SETUP_WARNINGS.cut(2));
  });

  it("text is cleaned with the shared cleaner: invisible characters and controls go (zero-width joiners too)", () => {
    const r = ok({ frames: [], notes: [frameNote("A​b\u0007c‮d", null), frameNote("Dev 👩‍💻", null)] });
    expect(r.content.notes.map((n) => n.text)).toEqual(["Abcd", "Dev 👩💻"]);
  });

  it("frame sizes are clamped to the frame limits", () => {
    const r = ok({ frames: [aFrame("a", 0, 0, { w: 9000, h: 10 })], notes: [] });
    expect(r.content.frames[0]).toMatchObject({ w: FRAME_MAX_W, h: FRAME_MIN_H });
    expect(r.warnings).toContain(SETUP_WARNINGS.resized(1));
  });

  it("a note naming a missing frame becomes loose", () => {
    const r = ok({ frames: [aFrame("a")], notes: [frameNote("in", "a"), frameNote("lost", "zz")] });
    expect(r.frames[0]!.notes.map((n) => n.text)).toEqual(["in"]);
    expect(r.loose.map((n) => n.text)).toEqual(["lost"]);
    expect(r.warnings).toContain(SETUP_WARNINGS.loose(1));
  });

  it("a duplicate frame ref is renamed: both frames kept, notes go to the first", () => {
    const r = ok({ frames: [aFrame("a", null, null, { title: "One" }), aFrame("a", null, null, { title: "Two" })], notes: [frameNote("n", "a")] });
    expect(r.frames.map((f) => [f.title, f.notes.length])).toEqual([
      ["One", 1],
      ["Two", 0],
    ]);
    expect(new Set(r.content.frames.map((f) => f.ref)).size).toBe(2);
    expect(r.warnings).toContain(SETUP_WARNINGS.renamed(1));
  });

  it("entries that can't be read are left out and counted", () => {
    const r = ok({ frames: [aFrame("a"), "frame?"], notes: [frameNote("ok", "a"), { color: "pink" }, 7] });
    expect(r.content.frames).toHaveLength(1);
    expect(r.content.notes).toHaveLength(1);
    expect(r.warnings).toContain(SETUP_WARNINGS.unreadable(3));
  });

  it("caps: at most 8 frames; notes in a dropped frame become loose", () => {
    const frames = Array.from({ length: 10 }, (_, i) => aFrame(`f${i}`));
    const r = ok({ frames, notes: [frameNote("first", "f0"), frameNote("tenth", "f9")] });
    expect(r.content.frames).toHaveLength(SETUP_LIMITS.frames);
    expect(r.loose.map((n) => n.text)).toEqual(["tenth"]);
    expect(r.warnings).toContain(SETUP_WARNINGS.overCap(2));
    expect(r.warnings).toContain(SETUP_WARNINGS.loose(1));
  });

  it("caps: at most 60 items in all (frames plus notes)", () => {
    const notes = Array.from({ length: 70 }, (_, i) => frameNote(`n${i}`, i % 2 ? "a" : null));
    const r = ok({ frames: [aFrame("a"), aFrame("b")], notes });
    expect(r.content.frames.length + r.content.notes.length).toBe(SETUP_LIMITS.items);
    expect(r.content.notes.map((n) => n.text)).toEqual(notes.slice(0, 58).map((n) => n.text));
    expect(r.warnings).toContain(SETUP_WARNINGS.overCap(12));
    expectTidy(r);
  });

  it("the room's remaining capacity: notes and frames beyond it are left out", () => {
    const r = ok(RETRO_REPLY, { notes: 4, frames: 1 });
    expect(r.content.frames.map((f) => f.title)).toEqual(["Went well"]);
    expect(r.content.notes).toHaveLength(4);
    expect(r.warnings).toContain(SETUP_WARNINGS.noRoom(2 + 2));
    expectTidy(r);
  });

  it("no room for frames at all: their notes become loose", () => {
    const r = ok(RETRO_REPLY, { notes: 200, frames: 0 });
    expect(r.content.frames).toEqual([]);
    expect(r.loose).toHaveLength(6);
    expectTidy(r);
  });
});

describe("layout: re-done by a fixed rule when coordinates are missing or overlap", () => {
  const relaid = (reply: unknown) => {
    const r = ok(reply);
    expect(r.relaidOut).toBe(true);
    expect(r.warnings).toContain(SETUP_WARNINGS.relaid);
    expectTidy(r);
    // Deterministic: the same reply, the same board.
    expect(ok(reply).content).toEqual(r.content);
    return r;
  };

  it("missing coordinates", () => {
    const r = relaid({ frames: [aFrame("a"), aFrame("b")], notes: [frameNote("1", "a"), frameNote("2", "a"), frameNote("3", "b"), frameNote("loose", null)] });
    expect(r.content.frames[0]).toMatchObject({ x: 0, y: 0 });
  });

  it("frames that overlap", () => {
    relaid({ frames: [aFrame("a", 0, 0), aFrame("b", 100, 100)], notes: [frameNote("1", "a", 24, 72)] });
  });

  it("notes that overlap", () => {
    relaid({ frames: [aFrame("a", 0, 0)], notes: [frameNote("1", "a", 24, 72), frameNote("2", "a", 60, 90)] });
  });

  it("a note outside its frame, or under the title", () => {
    relaid({ frames: [aFrame("a", 0, 0)], notes: [frameNote("1", "a", 900, 72)] });
    relaid({ frames: [aFrame("a", 0, 0)], notes: [frameNote("1", "a", 24, 0)] });
  });

  it("a loose note on a frame (it would join that frame)", () => {
    relaid({ frames: [aFrame("a", 0, 0)], notes: [frameNote("1", null, 100, 100)] });
  });

  it("many notes in one frame stay within the frame limits", () => {
    const r = relaid({ frames: [aFrame("a")], notes: Array.from({ length: 59 }, (_, i) => frameNote(`n${i}`, "a")) });
    const f = r.content.frames[0]!;
    expect(f.w).toBeLessThanOrEqual(FRAME_MAX_W);
    expect(r.frames[0]!.notes).toHaveLength(59);
  });
});
