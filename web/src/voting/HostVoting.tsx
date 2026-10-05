import { useId, useState } from "react";
import { Eraser, Eye, Minus, Play, Plus } from "lucide-react";
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import { useRoomUi } from "../rooms/roomStore";
import { BUDGET, HOST_VOTE_TEXT, confirmClearVotes, confirmRestartVote, confirmStopVote, hostVoteReasons, stepBudget } from "./voting";

/*
 * The host's dot voting controls (v0.18.0): from md up in the board bar's Session group (a
 * Voting button opens them), on phones in the Participants sheet's Session section. Start with a
 * budget (a stepper, 1 to 20 dots each, default 5: the relay's bounds), Stop and reveal (one
 * confirm) and Clear votes (one confirm). Starting again while a round is open or closed asks
 * first: it clears that round. Off with a visible reason when disconnected or while a run is
 * going (what turns End session off). The relay doesn't say how many people are voting, so
 * neither does this. Guests never get these.
 */
export function HostVotingControls({ className }: { className?: string }) {
  const id = useId();
  const room = useRoomUi((s) => s.room);
  const [budget, setBudget] = useState<number>(BUDGET.default);
  if (!room?.isHost) return null;
  const state = room.voting.state;
  const reasons = hostVoteReasons({ blocked: room.endReason, state });
  const start = () => {
    if (reasons.start !== null || (state !== "off" && !confirmRestartVote())) return;
    room.startVote(budget);
  };
  const off = (reason: string | null, key: string) => ({
    "aria-disabled": reason !== null || undefined,
    "aria-describedby": reason !== null ? `${id}-${key}` : undefined,
  });
  const reason = (text: string | null, key: string) =>
    text !== null && (
      <p id={`${id}-${key}`} data-host-vote-reason="" className="text-xs text-fg-muted">
        {text}
      </p>
    );
  return (
    <div data-host-voting="" role="group" aria-label={HOST_VOTE_TEXT.heading} className={cn("flex flex-col gap-sm", className)}>
      <p className="text-sm text-fg-muted">
        {state === "open" ? HOST_VOTE_TEXT.open : state === "closed" ? HOST_VOTE_TEXT.closed : "Everyone places dots on the notes they like."}
      </p>
      <div className="flex flex-wrap items-center gap-xs">
        <span id={`${id}-budget`} className="text-sm">
          {HOST_VOTE_TEXT.budget}
        </span>
        <div role="group" aria-labelledby={`${id}-budget`} className="flex items-center">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Fewer dots"
            title="Fewer dots"
            aria-disabled={budget <= BUDGET.min || undefined}
            onClick={() => setBudget((b) => stepBudget(b, -1))}
          >
            <Minus />
          </Button>
          <span data-vote-budget="" className="min-w-touch text-center text-sm font-semibold tabular-nums">
            {budget}
          </span>
          <Button
            variant="ghost"
            size="icon"
            aria-label="More dots"
            title="More dots"
            aria-disabled={budget >= BUDGET.max || undefined}
            onClick={() => setBudget((b) => stepBudget(b, 1))}
          >
            <Plus />
          </Button>
        </div>
      </div>
      <div className="flex flex-col gap-xs">
        <Button className="self-start" variant={state === "off" ? "primary" : "secondary"} {...off(reasons.start, "start")} onClick={start}>
          <Play />
          {state === "off" ? HOST_VOTE_TEXT.start : HOST_VOTE_TEXT.restart}
        </Button>
        <p className="text-xs text-fg-muted">{HOST_VOTE_TEXT.startNote}</p>
        {reason(reasons.start, "start")}
      </div>
      <div className="flex flex-col gap-xs">
        <Button
          className="self-start"
          variant={state === "open" ? "primary" : "secondary"}
          {...off(reasons.stop, "stop")}
          onClick={() => {
            if (reasons.stop === null && confirmStopVote()) room.stopVote();
          }}
        >
          <Eye />
          {HOST_VOTE_TEXT.stop}
        </Button>
        {reason(reasons.stop, "stop")}
      </div>
      <div className="flex flex-col gap-xs">
        <Button
          className="self-start"
          {...off(reasons.clear, "clear")}
          onClick={() => {
            if (reasons.clear === null && confirmClearVotes()) room.clearVotes();
          }}
        >
          <Eraser />
          {HOST_VOTE_TEXT.clear}
        </Button>
        {reason(reasons.clear, "clear")}
      </div>
    </div>
  );
}
