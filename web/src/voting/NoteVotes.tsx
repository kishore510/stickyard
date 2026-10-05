import { NodeToolbar, Position } from "@xyflow/react";
import { useMemo } from "react";
import { Circle, Trophy } from "lucide-react";
import { readPxToken } from "../lib/cssVar";
import { useRoomUi } from "../rooms/roomStore";
import { VoteButtons } from "./VoteButtons";
import { VOTE_TEXT, totalsOf, voteLabel } from "./voting";

/*
 * Voting on the board's notes (v0.18.0). Badges in a row just above the note (index.css
 * .sy-vote-badges): my dots while a round is open or closed, and once closed the note's total
 * and, for the notes tied for most, "Top voted". Text and an icon each, never colour alone; the
 * same is in the note's accessible name (useNoteVoteLabel). The selected note's − / + controls
 * sit below it in a React Flow NodeToolbar: screen-sized (44px targets at any zoom), outside the
 * note so they never cover its text or the resize handles.
 */

/** What a note's votes look like here: my dots, its total (closed only) and whether it's top voted. */
export function useNoteVoteView(id: string) {
  const state = useRoomUi((s) => s.room?.voting.state ?? "off");
  const mine = useRoomUi((s) => s.room?.myVotes.get(id) ?? 0);
  const total = useRoomUi((s) => (s.room?.results ? (totalsOf(s.room.results).byId.get(id) ?? 0) : 0));
  const top = useRoomUi((s) => {
    const results = s.room?.results;
    if (!results) return false;
    const t = totalsOf(results);
    return t.most > 0 && t.byId.get(id) === t.most;
  });
  const closed = state === "closed";
  return {
    state,
    mine: state === "off" ? 0 : mine,
    total: closed ? total : 0,
    top: closed && top,
  };
}

/** The badges' words for a screen reader (added to the note's name), "" when there's nothing. */
export function useNoteVoteLabel(id: string): string {
  const v = useNoteVoteView(id);
  return voteLabel({ mine: v.mine, total: v.total > 0 ? v.total : null, top: v.top });
}

export function VoteBadges({ id }: { id: string }) {
  const { mine, total, top } = useNoteVoteView(id);
  if (mine === 0 && total === 0) return null;
  return (
    <div aria-hidden="true" data-vote-badges="" className="sy-vote-badges">
      {mine > 0 && (
        <span data-my-dots="" className="sy-vote-badge" title="Your dots">
          <Circle className="fill-current text-accent" />
          {mine}
        </span>
      )}
      {total > 0 && (
        <span data-vote-total="" className="sy-vote-badge">
          Total {total}
        </span>
      )}
      {top && (
        <span data-top-voted="" className="sy-vote-badge">
          <Trophy />
          {VOTE_TEXT.topVoted}
        </span>
      )}
    </div>
  );
}

/** Above the canvas pane (z 1) whatever the note's own z, and below React Flow's panels (z 5). */
const TOOLBAR_STYLE = { zIndex: 4 } as const;

/** The selected note's − / + while a round is open. `nodrag nopan nowheel`: React Flow leaves presses here alone. */
export function VoteControls({ id, confirmed }: { id: string; confirmed: boolean }) {
  const offset = useMemo(() => readPxToken("--sy-vote-controls-offset", 16), []);
  return (
    <NodeToolbar
      isVisible
      position={Position.Bottom}
      offset={offset}
      style={TOOLBAR_STYLE}
      data-vote-controls=""
      className="nodrag nopan nowheel max-w-content rounded-md border border-border bg-surface p-xs shadow-md"
    >
      <VoteButtons noteId={id} confirmed={confirmed} />
    </NodeToolbar>
  );
}
