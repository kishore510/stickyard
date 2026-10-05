import { useEffect, useRef, useState, type ReactNode } from "react";
import { Circle } from "lucide-react";
import type { VotingState } from "@stickyard/shared";
import { stripText, voteAnnouncement, type AnnounceState } from "./voting";

/*
 * The voting strip (v0.18.0): under the top bar, in the board's notice stack after the lock
 * banner, for everyone while a round is open ("you have N of M dots left") or closed (results on
 * the notes). Persistent, no dismiss. The strip itself is plain text, not a live region, so dots
 * aren't announced one by one; one always-present polite region says when a round starts, when
 * my last dot is placed, and when it ends.
 */
export function VotingStrip({ voting, remaining, action }: { voting: VotingState; remaining: number; action?: ReactNode }) {
  const [announcement, setAnnouncement] = useState("");
  const previous = useRef<AnnounceState | null>(null);
  const { state, round, budget } = voting;
  useEffect(() => {
    const next = { state, round, budget, remaining };
    const text = voteAnnouncement(previous.current, next);
    previous.current = next;
    if (text) setAnnouncement(text);
  }, [state, round, budget, remaining]);
  const text = stripText(voting, remaining);
  return (
    <>
      <span data-vote-announcer="" role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </span>
      {text && (
        <div
          data-voting-strip=""
          data-state={state}
          className="pointer-events-auto flex max-w-content flex-wrap items-center gap-sm rounded-md border border-accent bg-surface px-ms py-xs text-sm text-fg shadow-md"
        >
          <Circle aria-hidden="true" className="size-icon-sm shrink-0 fill-current text-accent" />
          <span className="min-w-0 flex-1 tabular-nums">{text}</span>
          {action}
        </div>
      )}
    </>
  );
}
