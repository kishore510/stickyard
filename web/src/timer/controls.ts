import { useRoomUi } from "../rooms/roomStore";
import { TIMER_TEXT, remaining, stopNeedsConfirm } from "./timer";

/** Why the host's timer controls are off (null: they work). */
export const TIMER_HINTS = { offline: "Not connected." } as const;

/**
 * The host's timer commands, shared by the chip (md and up) and the Participants sheet (phones).
 * Stop asks first when more than a minute is left (`confirm` is injectable for tests).
 */
export function useTimerControls(confirm: (message: string) => boolean = (m) => window.confirm(m)) {
  const room = useRoomUi((s) => s.room);
  const reason = room?.live ? null : TIMER_HINTS.offline;
  return {
    reason,
    start: (durationMs: number) => room?.startTimer(durationMs) ?? false,
    restart: () => (room?.timer ? room.startTimer(room.timer.durationMs) : false),
    stop: () => {
      const t = room?.timer;
      if (!room || !t) return false;
      if (stopNeedsConfirm(remaining(t, Date.now(), t.offsetMs)) && !confirm(TIMER_TEXT.stopConfirm)) return false;
      return room.stopTimer();
    },
  };
}
