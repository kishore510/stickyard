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

const BORDERS = [
  "border-participant-1",
  "border-participant-2",
  "border-participant-3",
  "border-participant-4",
  "border-participant-5",
  "border-participant-6",
  "border-participant-7",
  "border-participant-8",
] as const satisfies { length: typeof PALETTE_SIZE };

const slotOf = (colourIndex: number) => ((Math.trunc(colourIndex) % PALETTE_SIZE) + PALETTE_SIZE) % PALETTE_SIZE;

export function participantColourClass(colourIndex: number): string {
  return CLASSES[slotOf(colourIndex)] ?? CLASSES[0];
}

/** The same colour as a border (the avatar stack's rings). */
export function participantBorderClass(colourIndex: number): string {
  return BORDERS[slotOf(colourIndex)] ?? BORDERS[0];
}
