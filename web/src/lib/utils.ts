import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// Teach tailwind-merge the token scale names, so e.g. `text-xs` (a size) and
// `text-fg` (a colour) aren't treated as conflicting.
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: ["xs", "sm", "base", "lg", "xl", "2xl", "note-s", "note-m", "note-l", "note-xl", "display"],
      spacing: ["2xs", "xs", "sm", "ms", "md", "lg", "xl", "touch", "header", "toolbar", "gutter", "icon", "icon-sm", "icon-lg", "logo", "brand-mark", "brand-mark-lg", "dot", "badge", "menu", "term", "sheet", "content", "note", "frame-header", "frame-edge", "board-w", "board-h", "swatch", "bar", "edge-b", "edge-l", "edge-r", "chat-w", "chat-h", "chat-b", "above-bar", "chat-bar-b", "strip", "handle", "line", "tile-preview", "row-tile"],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
