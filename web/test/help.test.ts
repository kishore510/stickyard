import { describe, expect, it } from "vitest";
import { HELP_TOPICS, QUICK_START_ID, topicById } from "../src/help/content";
import { linksIn, parseInline, parseMarkdown } from "../src/help/markdown";
import { buildTopics, parseFrontMatter, searchTopics } from "../src/help/topics";

describe("help topics", () => {
  it("loads the topics, quick start first", () => {
    expect(HELP_TOPICS.map((t) => t.id)).toEqual(["quick-start", "sessions", "notes", "participants", "chat", "names", "connection", "touch-and-keyboard"]);
    expect(topicById("sessions")?.title).toBe("Starting and joining a session");
    expect(topicById(QUICK_START_ID)?.title).toBe("Quick start");
  });

  it("every help: link points at a topic that exists", () => {
    for (const topic of HELP_TOPICS) {
      for (const href of linksIn(topic.blocks)) {
        const id = /^help:(.+)$/.exec(href)?.[1];
        if (id) expect(topicById(id), `${topic.id} links to ${href}`).toBeDefined();
      }
    }
  });

  it("names and identity describes what exists now", () => {
    const names = topicById("names");
    expect(names?.text).not.toContain("isn't in this version yet");
    expect(names?.text).toContain("anyone with the link can join");
    expect(names?.text).toContain("24 characters");
  });

  it("the Notes topic covers the caps and last-write-wins", () => {
    const notes = HELP_TOPICS.find((t) => t.id === "notes");
    expect(notes?.text).toContain("200 notes");
    expect(notes?.text).toContain("280 characters");
    expect(notes?.text).toContain("last wins");
  });

  it("the Notes topic covers editing in place (slice 2.9)", () => {
    const notes = HELP_TOPICS.find((t) => t.id === "notes")?.text ?? "";
    for (const claim of ["editing in place", "double-click", "type a title", "type body", "tab", "shift+enter", "esc"]) {
      expect(notes, claim).toContain(claim);
    }
  });

  it("the Notes topic covers selecting several notes, the marquee, right-drag panning and arranging (slice 2.8)", () => {
    const notes = HELP_TOPICS.find((t) => t.id === "notes")?.text ?? "";
    for (const claim of ["selecting several notes", "marquee", "shift", "ctrl+a", "right", "middle", "arranging notes", "align", "distribute", "match size", "first selected", "selected"]) {
      expect(notes, claim).toContain(claim);
    }
  });

  it("the Notes topic covers the palette, selecting, the Properties panel and panel shortcuts", () => {
    const notes = HELP_TOPICS.find((t) => t.id === "notes")?.text ?? "";
    // Topic text is lower-cased for search.
    for (const claim of ["palette", "drag a tile", "properties", "title", "body", "collapse", "resize", "[", "]"]) {
      expect(notes, claim).toContain(claim);
    }
    // No Stencils tab yet; colour change, text style and resizing exist (slice 2.7).
    expect(notes).not.toMatch(/stencil/i);
    expect(notes).not.toContain("arrives in a later update");
    for (const claim of ["resizing a note", "alt", "width", "height", "colour and text style", "bold", "italic", "title and the body each have their own size, bold, italic, alignment and text colour", "text colour", "auto"]) {
      expect(notes, claim).toContain(claim);
    }
  });

  it("the Chat topic covers timestamps and resizing", () => {
    const chat = HELP_TOPICS.find((t) => t.id === "chat")?.text ?? "";
    for (const claim of ["when it arrived", "grip", "arrow keys", "remembers the size"]) expect(chat, claim).toContain(claim);
  });

  it("help topics only claim what exists: no cursors, QR codes, timers or votes yet", () => {
    const all = HELP_TOPICS.map((t) => t.text).join("\n");
    expect(all).not.toMatch(/qr code|cursor|timer|vote|voting/);
  });

  it("rejects a file without valid front matter", () => {
    expect(() => parseFrontMatter("# no front matter")).toThrow();
    expect(() => buildTopics({ "./topics/x.md": "---\ntitle: X\n---\nbody" })).toThrow();
  });
});

describe("searchTopics", () => {
  it("returns nothing for an empty query", () => {
    expect(searchTopics(HELP_TOPICS, "  ")).toEqual([]);
  });

  it("filters by title, keywords and text, best first", () => {
    expect(searchTopics(HELP_TOPICS, "reload").map((r) => r.topic.id)[0]).toBe("connection");
    expect(searchTopics(HELP_TOPICS, "verified").map((r) => r.topic.id)).toContain("names");
    expect(searchTopics(HELP_TOPICS, "swipe").map((r) => r.topic.id)).toEqual(["touch-and-keyboard", "notes"]);
  });

  it("needs every word to match", () => {
    expect(searchTopics(HELP_TOPICS, "reload zebra")).toEqual([]);
  });

  it("gives a snippet from the body", () => {
    const [first] = searchTopics(HELP_TOPICS, "websockets");
    expect(first?.snippet?.toLowerCase()).toContain("websockets");
  });
});

describe("markdown", () => {
  it("keeps only help: and https links; anything else is plain text", () => {
    expect(parseInline("[a](help:names) [b](https://example.com) [c](javascript:void)")).toEqual([
      { type: "link", href: "help:names", children: [{ type: "text", text: "a" }] },
      { type: "text", text: " " },
      { type: "link", href: "https://example.com", children: [{ type: "text", text: "b" }] },
      { type: "text", text: " c" },
    ]);
  });

  it("never produces HTML: tags stay as text", () => {
    const blocks = parseMarkdown("<img src=x onerror=alert(1)>");
    expect(blocks).toEqual([{ type: "paragraph", children: [{ type: "text", text: "<img src=x onerror=alert(1)>" }] }]);
  });

  it("parses headings, lists and tips", () => {
    const blocks = parseMarkdown("## Title\n\n- one\n- two\n\n> tip");
    expect(blocks.map((b) => b.type)).toEqual(["heading", "list", "tip"]);
  });
});
