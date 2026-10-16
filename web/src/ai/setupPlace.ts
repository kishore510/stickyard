import { BOARD_HEIGHT, BOARD_WIDTH } from "@stickyard/shared";

/*
 * Board setup from a prompt (v0.43.0): where the generated board goes. The nearest free rectangle
 * to the view centre that holds all of it, with a margin from everything already on the board; if
 * there's none, just below the lowest item; always clamped onto the board. Pure and deterministic
 * (ties go to the higher, then the further-left spot).
 */

/** Candidate top-left corners are this far apart (board units). */
export const SETUP_PLACE_STEP = 40;
/** Space kept clear around existing items. */
export const SETUP_PLACE_MARGIN = 40;

type XY = { x: number; y: number };
type Rect = { x: number; y: number; w: number; h: number };

const clamp = (v: number, max: number) => Math.min(Math.max(0, Math.round(v)), Math.max(0, max));

/** Candidate positions along one axis: every step, the far edge, and the centred one. */
function stops(max: number, centred: number): number[] {
  const out = new Set<number>([clamp(centred, max), Math.max(0, max)]);
  for (let v = 0; v <= max; v += SETUP_PLACE_STEP) out.add(v);
  return [...out];
}

/** The result's top-left: `size` is its width and height, `items` what's on the board, `centre` the view's centre. */
export function findSetupPlace(size: { width: number; height: number }, items: readonly Rect[], centre: XY): XY {
  const maxX = BOARD_WIDTH - size.width;
  const maxY = BOARD_HEIGHT - size.height;
  const centredX = centre.x - size.width / 2;
  const centredY = centre.y - size.height / 2;
  const m = SETUP_PLACE_MARGIN;
  const free = (x: number, y: number) =>
    !items.some((r) => x < r.x + r.w + m && r.x - m < x + size.width && y < r.y + r.h + m && r.y - m < y + size.height);

  if (maxX >= 0 && maxY >= 0) {
    const candidates: XY[] = [];
    for (const y of stops(maxY, centredY)) for (const x of stops(maxX, centredX)) candidates.push({ x, y });
    const distance = (p: XY) => (p.x - centredX) ** 2 + (p.y - centredY) ** 2;
    candidates.sort((a, b) => distance(a) - distance(b) || a.y - b.y || a.x - b.x);
    const found = candidates.find((p) => free(p.x, p.y));
    if (found) return found;
  }
  // No free spot: just below the lowest item (or centred, on an empty board), clamped onto the board.
  const lowest = items.length === 0 ? null : Math.max(...items.map((r) => r.y + r.h));
  return { x: clamp(centredX, maxX), y: clamp(lowest === null ? centredY : lowest + m, maxY) };
}
