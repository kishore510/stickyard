import { useMemo, useRef } from "react";
import { Trophy } from "lucide-react";
import type { Board } from "../notes/board";
import { useBoardUi } from "../canvas/uiStore";
import { useRoomUi } from "../rooms/roomStore";
import type { VoteTotal } from "../rooms/session";
import { closeSheets } from "../shell/nav";
import { VOTE_TEXT, dotsWord, resultRows, type ResultRow } from "./voting";

/*
 * The Results list (v0.18.0), for everyone once a round is closed: in Properties with nothing
 * selected (md and up) and in the Results sheet (#/results, opened from the voting strip on
 * phones). Sorted by total (ties in note order), each row a note's title line and its total,
 * with "Top voted" in text for every note tied for first. A row selects the note and moves the
 * view to it. Titles are untrusted note text: plain text only. Never who voted.
 */

/** The list's rows for these results (null while not closed), kept the same object while they don't change (drags don't republish). */
export function useResultRows(results: readonly VoteTotal[] | null, board: Board): readonly ResultRow[] | null {
  const last = useRef<{ key: string; rows: readonly ResultRow[] | null }>({ key: "null", rows: null });
  return useMemo(() => {
    const rows = results ? resultRows(results, board.notes.map((n) => n.note)) : null;
    const key = JSON.stringify(rows);
    if (key !== last.current.key) last.current = { key, rows };
    return last.current.rows;
  }, [results, board]);
}

export function ResultsList({ rows, onPick }: { rows: readonly ResultRow[]; onPick: (noteId: string) => void }) {
  return (
    <section data-results="" aria-labelledby="results-heading" className="flex flex-col gap-sm">
      <h3 id="results-heading" className="text-sm font-semibold">
        Results
      </h3>
      {rows.length === 0 ? (
        <p className="text-sm text-fg-muted">{VOTE_TEXT.noResults}</p>
      ) : (
        <ol className="flex flex-col gap-xs">
          {rows.map((row) => (
            <li key={row.noteId}>
              <button
                type="button"
                data-result-row=""
                onClick={() => onPick(row.noteId)}
                className="flex min-h-touch w-full min-w-0 cursor-pointer items-center gap-sm rounded-md border border-border bg-surface px-ms text-left text-sm hover:bg-surface-muted focus-visible:ring-2 focus-visible:ring-focus"
              >
                <span data-result-title="" className="min-w-0 flex-1 truncate">
                  {row.title}
                </span>
                {row.top && (
                  <span data-result-top="" className="inline-flex shrink-0 items-center gap-2xs rounded-full bg-accent px-sm text-xs font-semibold text-accent-fg">
                    <Trophy aria-hidden="true" className="size-icon-sm" />
                    {VOTE_TEXT.topVoted}
                  </span>
                )}
                <span data-result-count="" className="shrink-0 font-semibold tabular-nums">
                  {dotsWord(row.count)}
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
      <p className="text-xs text-fg-muted">Only totals are shown: nobody sees who voted for what.</p>
    </section>
  );
}

/** Selects a note from the results and asks the board to show it. */
export const pickResult = (noteId: string) => useBoardUi.getState().requestReveal(noteId);

/** The Results sheet's content (#/results). */
export function ResultsPage() {
  const rows = useRoomUi((s) => s.room?.resultRows ?? null);
  if (!rows) return <p className="pb-md">There are no results to show. They appear here when the host stops a vote.</p>;
  return (
    <div className="pb-md">
      <ResultsList
        rows={rows}
        onPick={(id) => {
          pickResult(id);
          closeSheets();
        }}
      />
    </div>
  );
}
