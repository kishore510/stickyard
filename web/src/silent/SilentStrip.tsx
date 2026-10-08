import { useEffect, useRef, useState } from "react";
import { EyeOff } from "lucide-react";
import type { SilentState } from "@stickyard/shared";
import { silentAnnouncement, silentStripText } from "./silent";

/*
 * The silent brainstorm strip (v0.28.0), as the voting strip: under the top bar in the board's
 * notice stack, after the voting strip when both show, for everyone while a round runs. Persistent,
 * no dismiss, plain text (not a live region, so counts aren't read out one by one); one always-
 * present polite region says when a round starts and, once, how many notes the reveal showed.
 * Tokens only, no animation.
 */
export function SilentStrip({ silent, mine }: { silent: SilentState; mine: number }) {
  const [announcement, setAnnouncement] = useState("");
  const previous = useRef<SilentState | null>(null);
  const { active, count } = silent;
  useEffect(() => {
    const next = { active, count };
    const text = silentAnnouncement(previous.current, next);
    previous.current = next;
    if (text) setAnnouncement(text);
  }, [active, count]);
  const text = silentStripText(silent, mine);
  return (
    <>
      <span data-silent-announcer="" role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </span>
      {text && (
        <div
          data-silent-strip=""
          className="pointer-events-auto flex max-w-content items-start gap-sm rounded-md border border-accent bg-surface px-ms py-xs text-sm text-fg shadow-md"
        >
          <EyeOff aria-hidden="true" className="mt-2xs size-icon-sm shrink-0 text-accent" />
          {/* Two lines, so a phone's width never squeezes either into a column. */}
          <div className="flex min-w-0 flex-1 flex-col">
            <span>{text.lead}</span>
            <span data-silent-counts="" className="tabular-nums text-fg-muted">
              {text.counts}
            </span>
          </div>
        </div>
      )}
    </>
  );
}
