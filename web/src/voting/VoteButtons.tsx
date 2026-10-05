import { useId } from "react";
import { Circle, Minus, Plus } from "lucide-react";
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import { useRoomUi } from "../rooms/roomStore";
import { Section } from "../notes/StyleFields";
import { VOTE_TEXT, dotsWord, reasonLines, voteReasons } from "./voting";

/*
 * The − / + dot buttons for one note (v0.18.0): on the selected note (VoteControls), in
 * Properties and in the phone editor sheet (VotesSection). They read the room from roomStore,
 * so they work wherever they're shown. Off = aria-disabled (still focusable; the press does
 * nothing) with the reason as visible text next to them. The board lock never turns them off.
 */

/** What one note's vote buttons show and do. */
export function useNoteVotes(noteId: string, confirmed: boolean) {
  const room = useRoomUi((s) => s.room);
  const mine = room?.myVotes.get(noteId) ?? 0;
  const reasons = room
    ? voteReasons({ voting: room.voting, live: room.live, confirmed, isVoter: room.isVoter, votersFull: room.votersFull, remaining: room.remaining, mine })
    : { add: VOTE_TEXT.add, remove: VOTE_TEXT.remove };
  return {
    room,
    mine,
    reasons,
    add: () => reasons.add === null && room?.voteSet(noteId, mine + 1),
    remove: () => reasons.remove === null && room?.voteSet(noteId, mine - 1),
  };
}

/** Voting with the keyboard (D / Shift+D on a focused note): the same rules as the buttons. */
export function voteFromKey(noteId: string, confirmed: boolean, action: "add" | "remove"): boolean {
  const room = useRoomUi.getState().room;
  if (!room || room.voting.state !== "open") return false;
  const mine = room.myVotes.get(noteId) ?? 0;
  const reasons = voteReasons({ voting: room.voting, live: room.live, confirmed, isVoter: room.isVoter, votersFull: room.votersFull, remaining: room.remaining, mine });
  if (reasons[action] === null) room.voteSet(noteId, action === "add" ? mine + 1 : mine - 1);
  // Handled either way: an off key says nothing more than the controls already do.
  return true;
}

export function VoteButtons({ noteId, confirmed, className }: { noteId: string; confirmed: boolean; className?: string }) {
  const id = useId();
  const { mine, reasons, add, remove } = useNoteVotes(noteId, confirmed);
  const lines = reasonLines(reasons);
  const ref = (reason: string | null) => (reason === null ? undefined : `${id}-r${lines.indexOf(reason)}`);
  return (
    <div className={cn("flex flex-col gap-xs", className)}>
      <div role="group" aria-label="Your dots on this note" className="flex items-center gap-xs">
        <Button
          size="icon"
          aria-label={VOTE_TEXT.remove}
          title={VOTE_TEXT.remove}
          aria-disabled={reasons.remove !== null || undefined}
          aria-describedby={ref(reasons.remove)}
          onClick={remove}
        >
          <Minus />
        </Button>
        <span data-vote-count="" className="flex min-w-touch items-center justify-center gap-2xs text-sm font-semibold tabular-nums">
          <Circle aria-hidden="true" className="size-icon-sm fill-current text-accent" />
          {mine}
          <span className="sr-only"> {mine === 1 ? "dot" : "dots"} of yours</span>
        </span>
        <Button
          size="icon"
          aria-label={VOTE_TEXT.add}
          title={VOTE_TEXT.add}
          aria-disabled={reasons.add !== null || undefined}
          aria-describedby={ref(reasons.add)}
          onClick={add}
        >
          <Plus />
        </Button>
      </div>
      {lines.map((line, i) => (
        <p key={line} id={`${id}-r${i}`} data-vote-reason="" className="text-xs text-fg-muted">
          {line}
        </p>
      ))}
    </div>
  );
}

/**
 * Properties (one note) and the phone editor sheet: a Votes section while voting isn't off, with
 * my dots on the note, the buttons and dots left. Closed: the buttons are off ("Voting isn't open.").
 */
export function VotesSection({ noteId, confirmed }: { noteId: string; confirmed: boolean }) {
  const room = useRoomUi((s) => s.room);
  if (!room || room.voting.state === "off") return null;
  const total = room.results?.find((r) => r.noteId === noteId)?.count ?? 0;
  return (
    <div data-votes-section="">
      <Section title="Votes">
        <VoteButtons noteId={noteId} confirmed={confirmed} />
        {room.voting.state === "open" ? (
          <p className="text-sm text-fg-muted tabular-nums">
            You have {room.remaining} of {dotsWord(room.voting.budget)} left. Nobody sees who voted for what.
          </p>
        ) : (
          <p className="text-sm tabular-nums">
            <span className="text-fg-muted">Total on this note: </span>
            <span data-note-total="" className="font-semibold">
              {dotsWord(total)}
            </span>
          </p>
        )}
      </Section>
    </div>
  );
}
