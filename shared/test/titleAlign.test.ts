import { describe, expect, it } from "vitest";
import {
  NOTE_ALIGNS,
  NOTE_DEFAULTS,
  NOTE_EDIT_FIELDS,
  PROTOCOL_VERSION,
  clientMessageSchema,
  serverMessageSchema,
  type Note,
} from "../src/index";

/*
 * Protocol v5 (slice 2.7.1): the title (a note's first line) has its own alignment, apart from
 * the body's (`align`). Fixtures are generic.
 */

const NOTE_ID = "NNNNNNNNNNNNNNNN";
const note: Note = { id: NOTE_ID, x: 1, y: 2, ...NOTE_DEFAULTS, text: "Idea one\nThe details", color: "yellow", rev: 1, authorId: "AAAAAAAAAAAAAAAA" };

describe("title alignment (protocol v5)", () => {
  it("is protocol 5 or later, and titleAlign defaults to left like the body", () => {
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(5);
    expect(NOTE_DEFAULTS.titleAlign).toBe("left");
    expect(NOTE_DEFAULTS.align).toBe("left");
    expect(NOTE_EDIT_FIELDS).toContain("titleAlign");
  });

  it.each(NOTE_ALIGNS)("noteEdit accepts titleAlign %s on its own", (titleAlign) => {
    expect(clientMessageSchema.safeParse({ type: "noteEdit", id: NOTE_ID, titleAlign }).success).toBe(true);
  });

  it("noteEdit accepts title and body alignment together", () => {
    expect(clientMessageSchema.safeParse({ type: "noteEdit", id: NOTE_ID, titleAlign: "center", align: "right" }).success).toBe(true);
  });

  it.each([
    ["an unknown key", "middle"],
    ["CSS", "justify"],
    ["odd case", "Center"],
    ["a number", 1],
    ["null", null],
  ])("noteEdit rejects titleAlign as %s", (_label, titleAlign) => {
    expect(clientMessageSchema.safeParse({ type: "noteEdit", id: NOTE_ID, titleAlign }).success).toBe(false);
  });

  it("a note on the wire must have titleAlign (a v4 note without it is refused)", () => {
    expect(serverMessageSchema.safeParse({ type: "noteUpdated", note }).success).toBe(true);
    expect(serverMessageSchema.safeParse({ type: "noteUpdated", note: { ...note, titleAlign: "center", align: "right" } }).success).toBe(true);
    const { titleAlign: _drop, ...v4 } = note;
    expect(serverMessageSchema.safeParse({ type: "noteUpdated", note: v4 }).success).toBe(false);
    expect(serverMessageSchema.safeParse({ type: "noteUpdated", note: { ...note, titleAlign: "justify" } }).success).toBe(false);
  });
});
