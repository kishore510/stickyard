import { useReactFlow } from "@xyflow/react";
import { useEffect, useRef, type RefObject } from "react";
import { CursorSender, onBoardPoint, pointerMaySend } from "./cursors";
import { useCursorPrefs } from "./prefs";

/**
 * Shares my pointer from the board (protocol v14): md and up only (`enabled`), from a mouse or a
 * hovering pen (pointerMaySend: by pointer type, never screen size), converted to board units,
 * throttled by CursorSender. Leaving the board area, the window losing focus, the tab hiding and
 * switching Share off all send cursorLeft (once, if the cursor was shown). The session refuses
 * sends while disconnected, hidden or alone.
 */
export function useCursorSharing(
  section: RefObject<HTMLElement | null>,
  enabled: boolean,
  room: { shareCursor(x: number, y: number): boolean; hideCursor(): void },
): void {
  const flow = useReactFlow();
  const share = useCursorPrefs((s) => s.share);
  const latest = useRef(room);
  latest.current = room;
  const on = enabled && share;

  useEffect(() => {
    const el = section.current;
    if (!el || !on) return;
    const sender = new CursorSender({
      now: () => performance.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (id) => clearTimeout(id),
      send: (x, y) => latest.current.shareCursor(x, y),
      leave: () => latest.current.hideCursor(),
    });
    const move = (e: PointerEvent) => {
      if (!pointerMaySend(e)) return;
      const p = flow.screenToFlowPosition({ x: e.clientX, y: e.clientY }, { snapToGrid: false });
      if (onBoardPoint(p.x, p.y)) sender.move(p.x, p.y);
      else sender.leave();
    };
    const leave = () => sender.leave();
    const visibility = () => {
      if (document.visibilityState === "hidden") sender.leave();
    };
    el.addEventListener("pointermove", move, { passive: true });
    el.addEventListener("pointerleave", leave);
    window.addEventListener("blur", leave);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerleave", leave);
      window.removeEventListener("blur", leave);
      document.removeEventListener("visibilitychange", visibility);
      // Switched off, or the board went away: the cursor leaves.
      sender.leave();
    };
  }, [section, on, flow]);
}
