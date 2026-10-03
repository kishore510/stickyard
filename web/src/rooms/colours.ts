import { PALETTE_SIZE } from "@stickyard/shared";

/*
 * Participant colours come from the design tokens (--sy-participant-1..8, light and dark).
 * Spelled out in full so Tailwind generates each class. Colour is never the only cue:
 * the name is always shown next to it.
 */
const CLASSES = [
  "bg-participant-1",
  "bg-participant-2",
  "bg-participant-3",
  "bg-participant-4",
  "bg-participant-5",
  "bg-participant-6",
  "bg-participant-7",
  "bg-participant-8",
] as const satisfies { length: typeof PALETTE_SIZE };

export function participantColourClass(colourIndex: number): string {
  const slot = ((Math.trunc(colourIndex) % PALETTE_SIZE) + PALETTE_SIZE) % PALETTE_SIZE;
  return CLASSES[slot] ?? CLASSES[0];
}
