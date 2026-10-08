import { useId } from "react";
import { Eye, EyeOff } from "lucide-react";
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import { useRoomUi } from "../rooms/roomStore";
import { SILENT_UI, confirmRevealSilent, confirmStartSilent, hostSilentReasons } from "./silent";

/*
 * The host's silent brainstorm controls (v0.28.0): from md up in the board bar's Session group
 * (a Silent brainstorm button opens them, beside Voting), on phones in the Participants sheet's
 * Session section. Start and Reveal each ask once, saying what happens; each waits for the relay
 * (off with "Waiting for the relay…") and is off with a visible reason otherwise. The relay allows
 * a round during an open vote, so Start stays on then. Guests never get these.
 */
export function HostSilentControls({ className }: { className?: string }) {
  const id = useId();
  const room = useRoomUi((s) => s.room);
  if (!room?.isHost) return null;
  const { active, count } = room.silent;
  const reasons = hostSilentReasons({ live: room.live, active, pending: room.silentPending });
  const off = (reason: string | null, key: string) => ({
    "aria-disabled": reason !== null || undefined,
    "aria-describedby": reason !== null ? `${id}-${key}` : undefined,
  });
  const reason = (text: string | null, key: string) =>
    text !== null && (
      <p id={`${id}-${key}`} data-host-silent-reason="" className="text-xs text-fg-muted">
        {text}
      </p>
    );
  return (
    <div data-host-silent="" role="group" aria-label={SILENT_UI.heading} className={cn("flex flex-col gap-sm", className)}>
      <p className="text-sm text-fg-muted">{active ? SILENT_UI.running(count) : SILENT_UI.about}</p>
      <div className="flex flex-col gap-xs">
        <Button
          className="self-start"
          variant={active ? "secondary" : "primary"}
          {...off(reasons.start, "start")}
          onClick={() => {
            if (reasons.start !== null || !confirmStartSilent({ locked: room.locked, votingOpen: room.voting.state === "open" })) return;
            room.startSilent();
          }}
        >
          <EyeOff />
          {SILENT_UI.start}
        </Button>
        {reason(reasons.start, "start")}
      </div>
      <div className="flex flex-col gap-xs">
        <Button
          className="self-start"
          variant={active ? "primary" : "secondary"}
          {...off(reasons.reveal, "reveal")}
          onClick={() => {
            if (reasons.reveal !== null || !confirmRevealSilent(count)) return;
            room.revealSilent();
          }}
        >
          <Eye />
          {SILENT_UI.reveal}
        </Button>
        {reason(reasons.reveal, "reveal")}
      </div>
    </div>
  );
}
