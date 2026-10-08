import { X } from "lucide-react";
import { useEffect } from "react";
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import { useBoardUi } from "./uiStore";
import { SILENT_UI } from "../silent/silent";

/*
 * What the last view change did, in the board's notice stack (v0.24.0): Fit left a far item out
 * ("Some items are out of view." with Show all, until Show all, Dismiss or the next view command),
 * or a jump to someone's pointer ("Moved to Sam's pointer.", gone after JUMP_NOTICE_MS). The text
 * is in a polite status that's always in the page, so screen readers hear each one once. Names
 * are untrusted: plain text, already truncated.
 */

export const VIEW_TEXT = {
  outside: "Some items are out of view.",
  showAll: "Show all",
  jump: (name: string) => `Moved to ${name}’s pointer.`,
} as const;

/** After a Fit to notes: "Some items are out of view." when it left items out, else nothing. */
export function showFitNotice(partial: boolean): void {
  const ui = useBoardUi.getState();
  ui.setViewNotice(partial ? { kind: "outside", n: (ui.viewNotice?.n ?? 0) + 1 } : null);
}

/** How long the jump line stays. */
export const JUMP_NOTICE_MS = 4000;

/**
 * `onFit` is Fit to notes, for the line after a silent round's reveal (v0.28.0) when some revealed
 * notes are out of view: the reveal itself never moves the view.
 */
export function ViewNotices({ onShowAll, onFit }: { onShowAll: () => void; onFit?: () => void }) {
  const notice = useBoardUi((s) => s.viewNotice);
  // The jump line goes by itself; Fit's stays until it's dealt with.
  useEffect(() => {
    if (notice?.kind !== "jump") return;
    const timer = setTimeout(() => {
      if (useBoardUi.getState().viewNotice === notice) useBoardUi.getState().setViewNotice(null);
    }, JUMP_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);
  const text =
    notice === null ? "" : notice.kind === "outside" ? VIEW_TEXT.outside : notice.kind === "revealed" ? SILENT_UI.outside : VIEW_TEXT.jump(notice.name);
  return (
    <div
      data-view-notice={notice?.kind ?? ""}
      className={cn(
        "flex max-w-content items-center gap-sm rounded-md bg-surface text-sm shadow-md",
        notice ? "pointer-events-auto py-2xs pr-2xs pl-ms" : "sr-only",
      )}
    >
      <p role="status" aria-live="polite" className="min-w-0 break-words">
        {text}
      </p>
      {(notice?.kind === "outside" || notice?.kind === "revealed") && (
        <>
          <Button variant="ghost" onClick={notice.kind === "revealed" ? onFit : onShowAll}>
            {notice.kind === "revealed" ? SILENT_UI.fit : VIEW_TEXT.showAll}
          </Button>
          <Button variant="ghost" size="icon" aria-label="Dismiss" title="Dismiss" onClick={() => useBoardUi.getState().setViewNotice(null)}>
            <X />
          </Button>
        </>
      )}
    </div>
  );
}
