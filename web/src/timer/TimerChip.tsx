import { RotateCcw, Square, Timer as TimerIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { CommandButton } from "../canvas/SelectionBar";
import { useMediaQuery } from "../lib/useMediaQuery";
import { cn } from "../lib/utils";
import { useRoomUi } from "../rooms/roomStore";
import { MEDIA } from "../styles/breakpoints";
import { useTimerControls } from "./controls";
import { TIMER_TEXT, chipVisible, formatRemaining, remaining, timerAnnouncement, timerPhase, type TimerMoment } from "./timer";
import { useNow } from "./useNow";

/*
 * The room timer in the top bar, for everyone in a session while a timer exists (and for 10
 * minutes after it finished). md and up beside the avatar stack, with Restart and Stop for the
 * host; phones a compact chip with no controls (the host's are in the Participants sheet).
 * States by tokens and text, never colour alone: running; the last minute ("Last minute", warning
 * ink, bold); finished ("Time's up", accent fill). No animation at all. The countdown isn't a live
 * region: one polite region (always there in a session) announces the start, the last minute and
 * the end, once each.
 */
export function TimerChip() {
  const room = useRoomUi((s) => s.room);
  const timer = room?.timer ?? null;
  const wide = useMediaQuery(MEDIA.tablet);
  const now = useNow(timer !== null);
  const controls = useTimerControls();

  const left = timer ? remaining(timer, now, timer.offsetMs) : 0;
  const phase = timerPhase(left);
  const visible = chipVisible(timer, now, timer?.offsetMs ?? 0);
  const moment: TimerMoment | null = timer && visible ? { key: `${timer.startedAt}:${timer.durationMs}`, phase, durationMs: timer.durationMs } : null;

  // The announcement changes only at a start, the last minute and the end (never per tick).
  const [announcement, setAnnouncement] = useState("");
  const previous = useRef<TimerMoment | null>(null);
  const momentKey = moment ? `${moment.key}|${moment.phase}` : "";
  useEffect(() => {
    const text = timerAnnouncement(previous.current, moment);
    previous.current = moment;
    if (text) setAnnouncement(text);
    // Only when the key or phase changes.
  }, [momentKey]);

  if (!room) return null;
  const host = room.isHost && wide;
  return (
    <>
      <span data-timer-announcer="" role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </span>
      {timer && visible && (
        <div
          data-timer-chip=""
          data-phase={phase}
          data-compact={wide ? undefined : "true"}
          className={cn(
            "flex min-h-touch shrink-0 items-center gap-xs rounded-full border border-border bg-surface tabular-nums",
            wide ? "pl-ms" : "px-sm text-sm",
            phase === "final" && "border-status-warn font-semibold text-status-warn",
            phase === "finished" && "border-accent bg-accent-subtle font-semibold text-fg",
          )}
        >
          <TimerIcon aria-hidden="true" className="size-icon-sm shrink-0" />
          {phase === "final" && <span className={cn(!wide && "sr-only")}>{TIMER_TEXT.lastMinuteCue}</span>}
          {phase === "finished" ? <span>{TIMER_TEXT.finishedCue}</span> : <span role="timer" aria-label="Time left">{formatRemaining(left)}</span>}
          {host ? (
            <span className="flex items-center">
              <CommandButton command={{ title: "Restart timer", icon: <RotateCcw />, disabled: controls.reason !== null, ...(controls.reason ? { hint: controls.reason } : {}), run: () => void controls.restart() }} />
              <CommandButton command={{ title: "Stop timer", icon: <Square />, disabled: controls.reason !== null, ...(controls.reason ? { hint: controls.reason } : {}), run: () => void controls.stop() }} />
            </span>
          ) : (
            wide && <span aria-hidden="true" className="w-xs" />
          )}
        </div>
      )}
    </>
  );
}
