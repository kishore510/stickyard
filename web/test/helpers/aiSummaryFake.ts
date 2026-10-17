import type { Frame, Note } from "@stickyard/shared";
import { frameAt, noteAt } from "./ui";

/*
 * Summary and sentiment (10c, v0.44.0): a generic retro board and a canned reply for the fake
 * fetch. Generic content only; fake keys only. Nothing here reaches the network.
 */

export { setupStream as summaryStream, streamResponse } from "./aiSetupFake";

export const SUMMARY_KEY = "sk-ant-api03-FAKE-summary-test-key-0000smry";

/** Two frames side by side and five notes: two in each frame, one loose above them. */
export const RETRO_FRAMES: Frame[] = [frameAt(0, { title: "Went well", x: 40, y: 400 }), frameAt(1, { title: "To improve", x: 740, y: 400 })];
export const RETRO_NOTES: Note[] = [
  noteAt(1, { text: "Shipped on time", x: 80, y: 480 }),
  noteAt(2, { text: "Good pairing", x: 260, y: 480 }),
  noteAt(3, { text: "Too many meetings", x: 780, y: 480 }),
  noteAt(4, { text: "Unclear tickets", x: 960, y: 480 }),
  noteAt(5, { text: "Parking lot: tooling", x: 40, y: 60 }),
];

/** The reply for RETRO_NOTES: refs f1, f2 (frames in reading order), n1 to n4 by frame, n5 loose. */
export const RETRO_SUMMARY = {
  overview: "The team shipped on time and paired well, but meetings and unclear tickets slowed the work down.",
  themes: [
    { title: "Delivery", summary: "Shipping on time and pairing went well.", noteRefs: ["n1", "n2"] },
    { title: "Process friction", summary: "Meetings and tickets got in the way.", noteRefs: ["n3", "n4"] },
  ],
  sentiment: {
    overall: "mixed",
    reason: "Wins on delivery, friction in the process.",
    notes: [
      { ref: "n1", label: "positive" },
      { ref: "n2", label: "positive" },
      { ref: "n3", label: "negative" },
      { ref: "n4", label: "negative" },
      { ref: "n5", label: "neutral" },
    ],
    frames: [
      { ref: "f1", label: "positive", reason: null },
      { ref: "f2", label: "negative", reason: "Process friction." },
    ],
  },
  actions: [
    { text: "Trial a meeting-free afternoon.", noteRefs: ["n3"] },
    { text: "Agree a ticket template.", noteRefs: ["n4"] },
  ],
};
