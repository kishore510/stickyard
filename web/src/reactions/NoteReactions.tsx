import { memo, useMemo, useRef, useState, type SyntheticEvent } from "react";
import { useStore } from "@xyflow/react";
import { SmilePlus } from "lucide-react";
import { useMediaQuery } from "../lib/useMediaQuery";
import { cn } from "../lib/utils";
import { useRoomUi } from "../rooms/roomStore";
import { Section } from "../notes/StyleFields";
import { MEDIA } from "../styles/breakpoints";
import { ReactionPicker } from "./ReactionPicker";
import { REACTIONS, REACTION_TEXT, chipLabel, chipsOf, reactionMode, reactionsLabel, summaryOf, type Chip } from "./reactions";
import { setReaction, useReactionUi } from "./reactionStore";

/*
 * Reactions on a note (v0.34.0). The same row in three places: under the note on the board, in
 * Properties (md and up) and in the phone editor sheet. Chips for each key with a count above 0
 * (emoji and count; mine outlined and pressed), then Add reaction, which opens the picker. On
 * the board the row sits below the note in board units (it never covers the text or changes the
 * note's size), Add reaction only on the one selected note, and presses there never select or
 * drag the note. Nothing at all on my sealed notes during a silent round.
 */

/** A note's chips, from the room (the same objects while nothing changes for this note). */
export function useNoteChips(noteId: string): Chip[] {
  const counts = useRoomUi((s) => s.room?.reactionCounts.get(noteId));
  const mine = useRoomUi((s) => s.room?.myReactions.get(noteId));
  return useMemo(() => chipsOf(counts, mine), [counts, mine]);
}

/** The counts' words for a screen reader (added to the note's name), "" when there are none. */
export function useNoteReactionLabel(noteId: string): string {
  return reactionsLabel(useNoteChips(noteId));
}

function ReactionChip({ noteId, chip }: { noteId: string; chip: Chip }) {
  const reduced = useMediaQuery(MEDIA.reducedMotion);
  const [pop, setPop] = useState(false);
  const { emoji } = REACTIONS[chip.key];
  return (
    <button
      type="button"
      data-reaction={chip.key}
      data-mine={chip.mine || undefined}
      aria-pressed={chip.mine}
      aria-label={chipLabel(chip.key, chip.count, chip.mine)}
      title={REACTIONS[chip.key].name}
      onClick={() => {
        const on = !chip.mine;
        // A small pop when I add mine; none with reduced motion.
        setPop(on && !reduced);
        setReaction(noteId, chip.key, on);
      }}
      onAnimationEnd={() => setPop(false)}
      className={cn("sy-reaction-chip", pop && "sy-reaction-pop")}
    >
      <span aria-hidden="true" className="sy-reaction-emoji">
        {emoji}
      </span>
      <span aria-hidden="true">{chip.count}</span>
    </button>
  );
}

/** Add reaction and its picker; focus comes back here when the picker closes. */
function AddReaction({ noteId }: { noteId: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={ref}
        type="button"
        data-reaction-add=""
        // A control, never in an exported PNG (as the vote controls).
        data-export-skip=""
        aria-label={REACTION_TEXT.add}
        title={REACTION_TEXT.add}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="sy-reaction-chip sy-reaction-add"
      >
        <SmilePlus aria-hidden="true" />
      </button>
      {open && <ReactionPicker noteId={noteId} opener={ref.current} onClose={() => setOpen(false)} />}
    </>
  );
}

/** The chips, then Add reaction when `add`. */
export function ReactionRow({ noteId, add, className, ...rest }: { noteId: string; add: boolean; className?: string } & Record<`data-${string}`, string>) {
  const chips = useNoteChips(noteId);
  if (chips.length === 0 && !add) return null;
  return (
    <div role="group" aria-label={REACTION_TEXT.section} className={className} {...rest}>
      {chips.map((chip) => (
        <ReactionChip key={chip.key} noteId={noteId} chip={chip} />
      ))}
      {add && <AddReaction noteId={noteId} />}
    </div>
  );
}

/** Presses and keys in the row are the row's: React Flow's node handlers and the note never see them. */
const contain = (e: SyntheticEvent) => e.stopPropagation();
const GUARDS = { onPointerDown: contain, onMouseDown: contain, onClick: contain, onDoubleClick: contain, onKeyDown: contain, onContextMenu: contain };

/**
 * Under a note on the board. Full zoom: the row (Add reaction on the selected note). Middle zoom:
 * one quiet summary, not a control. Low zoom: nothing. `add` is false for an unsaved note.
 */
export const BoardReactions = memo(function BoardReactions({ noteId, add }: { noteId: string; add: boolean }) {
  const mode = useStore((s) => reactionMode(s.transform[2]));
  const chips = useNoteChips(noteId);
  if (mode === "none") return null;
  if (mode === "summary") {
    if (chips.length === 0) return null;
    const { emoji, total } = summaryOf(chips);
    return (
      <div aria-hidden="true" data-reaction-summary="" className="sy-reactions-summary">
        {emoji.join("")}
        <span className="text-xs">{total}</span>
      </div>
    );
  }
  if (chips.length === 0 && !add) return null;
  return (
    <div className="sy-reactions nodrag nopan nowheel" data-reactions="" {...GUARDS}>
      <ReactionRow noteId={noteId} add={add} className="contents" />
    </div>
  );
});

/**
 * Properties (one note) and the phone editor sheet: a Reactions section with the same row in the
 * same order, Add reaction always there. Not on my sealed notes (silent brainstorm) nor before
 * the note is saved.
 */
export function ReactionsSection({ noteId, confirmed }: { noteId: string; confirmed: boolean }) {
  const sealed = useRoomUi((s) => s.room?.mySealed.has(noteId) ?? true);
  if (sealed || !confirmed) return null;
  return (
    <div data-reactions-section="">
      <Section title={REACTION_TEXT.section}>
        <ReactionRow noteId={noteId} add className="flex flex-wrap items-center gap-xs" />
        <p className="text-sm text-fg-muted">{REACTION_TEXT.hint}</p>
      </Section>
    </div>
  );
}

/** The one polite region for my own reaction actions (never anyone else's), always in the page. */
export function ReactionAnnouncer() {
  const announce = useReactionUi((s) => s.announce);
  return (
    <span data-reaction-announcer="" role="status" aria-live="polite" aria-atomic="true" className="sr-only">
      {announce?.text ?? ""}
    </span>
  );
}
