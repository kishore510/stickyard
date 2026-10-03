import { describe, expect, it } from "vitest";
import { HELP_TOPICS, QUICK_START_ID, topicById } from "../src/help/content";
import { linksIn, parseInline, parseMarkdown } from "../src/help/markdown";
import { buildTopics, parseFrontMatter, searchTopics } from "../src/help/topics";

describe("help topics", () => {
  it("loads the topics, quick start first", () => {
    expect(HELP_TOPICS.map((t) => t.id)).toEqual(["quick-start", "sessions", "notes", "names", "connection", "touch-and-keyboard"]);
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

  it("help topics only claim what exists: no cursors, QR codes, timers or votes yet", () => {
    const all = HELP_TOPICS.map((t) => t.text).join("\n");
    expect(all).not.toMatch(/qr code|cursor|timer|vote|voting|zoom|minimap/);
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
