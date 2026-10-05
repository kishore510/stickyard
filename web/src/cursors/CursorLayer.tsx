import { ViewportPortal, useStore } from "@xyflow/react";
import { memo, useMemo } from "react";
import { readPxToken } from "../lib/cssVar";
import { cn } from "../lib/utils";
import { participantColourClass, participantColourVar } from "../rooms/colours";
import { useRoomUi } from "../rooms/roomStore";
import { cursorLabel, placeCursor, type VisibleArea } from "./cursors";
import { useCursors } from "./cursorStore";
import { useCursorPrefs } from "./prefs";

/*
 * Other people's pointers (protocol v14), drawn in the viewport above the notes. A layer of its
 * own: it reads the cursor store, so a moving pointer re-renders only its own mark, never a note.
 * Each mark is counter-scaled (constant screen size at any zoom) and kept inside the visible area;
 * positions ease between updates (instant under reduced motion, via the token). Decorative:
 * aria-hidden and pointer-events none (the avatar stack and Participants are the accessible record).
 * Names are untrusted: plain text, truncated.
 */

/** Room kept for the arrow and the label beside it (screen px), to keep a mark inside the view. */
const RESERVE = { arrow: 20, label: 120 };
/** The arrow, tip at the mark's origin (the pointer's position). */
const ARROW = "M3 2 L3 16 L7 12.5 L9.5 18 L12 17 L9.5 11.5 L15 11.5 Z";

const CursorMark = memo(function CursorMark({ id, name, colourIndex, view, zoom, compact }: { id: string; name: string; colourIndex: number; view: VisibleArea; zoom: number; compact: boolean }) {
  const cursor = useCursors((s) => s.cursors.get(id));
  if (!cursor) return null;
  const place = placeCursor(cursor, view, zoom, RESERVE);
  return (
    <div
      data-cursor={id}
      data-compact={compact || undefined}
      className={cn("sy-cursor", cursor.idle && "sy-cursor-idle", place.flip && "sy-cursor-flip")}
      style={{ transform: `translate(${place.x}px, ${place.y}px) scale(${place.scale})` }}
    >
      <svg className={cn("sy-cursor-arrow", compact && "sy-cursor-arrow-sm")} viewBox="0 0 20 20" aria-hidden="true" focusable="false">
        {/* A dark outline under a light edge: one of the two reads on any note, frame or board colour. */}
        <path d={ARROW} style={{ fill: "none", stroke: "var(--sy-cursor-outline)", strokeWidth: 4, strokeLinejoin: "round" }} />
        <path d={ARROW} style={{ fill: participantColourVar(colourIndex), stroke: "var(--sy-cursor-halo)", strokeWidth: 1.5, strokeLinejoin: "round" }} />
      </svg>
      <span data-cursor-label="" className={cn("sy-cursor-label", compact ? "text-xs" : "text-sm", participantColourClass(colourIndex))}>
        {cursorLabel(name)}
      </span>
    </div>
  );
});

function Marks({ compact }: { compact: boolean }) {
  const ids = useCursors((s) => s.cursors);
  const participants = useRoomUi((s) => s.room?.participants);
  const [tx, ty, zoom] = useStore((s) => s.transform);
  const width = useStore((s) => s.width);
  const height = useStore((s) => s.height);
  const view = useMemo<VisibleArea>(
    () => ({ x: -tx / zoom, y: -ty / zoom, width: (width || readPxToken("--sy-board-width", 3200)) / zoom, height: (height || readPxToken("--sy-board-height", 2000)) / zoom }),
    [tx, ty, zoom, width, height],
  );
  const people = useMemo(() => new Map((participants ?? []).map((p) => [p.id, p])), [participants]);
  // Only people here now (the session already leaves out my own and unknown ids).
  const shown = [...ids.keys()].flatMap((id) => people.get(id) ?? []);
  return (
    <>
      {shown.map((p) => (
        <CursorMark key={p.id} id={p.id} name={p.name} colourIndex={p.colourIndex} view={view} zoom={zoom} compact={compact} />
      ))}
    </>
  );
}

/** Inside <ReactFlow>. Nothing at all while Show other people's cursors is off. */
export function CursorLayer({ compact }: { compact: boolean }) {
  const show = useCursorPrefs((s) => s.show);
  if (!show) return null;
  return (
    <ViewportPortal>
      <div data-cursor-layer="" aria-hidden="true" className="sy-cursor-layer pointer-events-none">
        <Marks compact={compact} />
      </div>
    </ViewportPortal>
  );
}
