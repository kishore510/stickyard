import { Timer as TimerIcon } from "lucide-react";
import { useBoardUi } from "../canvas/uiStore";
import { useRoomUi } from "../rooms/roomStore";
import { Sheet } from "../shell/Sheet";
import { useTimerControls } from "./controls";
import { TimerForm } from "./TimerForm";

/** The host's duration picker (md and up), opened from the palette's Timer tile: the timer form in a sheet. */
export function TimerPicker() {
  const open = useBoardUi((s) => s.timerPickerOpen);
  const setOpen = useBoardUi((s) => s.setTimerPickerOpen);
  const room = useRoomUi((s) => s.room);
  const controls = useTimerControls();
  if (!open || !room?.isHost) return null;
  return (
    <Sheet title="Start a timer" icon={<TimerIcon />} page="timer" onClose={() => setOpen(false)}>
      <div className="pb-md">
        <TimerForm
          running={room.timer !== null}
          reason={controls.reason}
          onStart={(ms) => {
            if (controls.start(ms)) setOpen(false);
          }}
        />
      </div>
    </Sheet>
  );
}
