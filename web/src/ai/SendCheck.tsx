import { useEffect, useId, useRef } from "react";
import { Button } from "../components/ui/button";
import type { AiModel } from "./models";

/*
 * Check before sending (v0.42.0): the page every AI request goes through before anything leaves the
 * browser. Built for Test key now; later AI features reuse it. A page inside the sheet, not a stacked
 * dialog; Cancel has focus, so Enter or a stray tap never sends. The optional first-time notice is
 * shown once (the caller keeps `seen`); Test key doesn't show it.
 */

export const FIRST_TIME_NOTICE =
  "What you send leaves this device and goes to Anthropic's API, using your key and your account. In a shared session, board text includes what other people typed. Check your own or your organisation's rules before sending anything sensitive. Shown once.";

export const WHERE_IT_GOES = "It goes straight from this browser to api.anthropic.com. Stickyard has no AI server.";

/** The size estimate shown before a send: characters / 3, rounded up (an estimate, not a count). */
export function estimateTokens(chars: number): number {
  return Math.ceil(Math.max(0, chars) / 3);
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function FirstTimeNotice() {
  return (
    <p data-ai-notice="" role="note" className="rounded-md border border-border-strong bg-surface-muted p-ms text-sm text-fg">
      {FIRST_TIME_NOTICE}
    </p>
  );
}

export function SendCheck({
  models,
  items,
  chars,
  onSend,
  onCancel,
  notice,
  extra = [],
  blocked = null,
}: {
  models: readonly AiModel[];
  /** What's sent, one bullet each. */
  items: readonly string[];
  /** Characters sent, for the estimate. */
  chars: number;
  onSend: () => void;
  onCancel: () => void;
  /** The first-time notice: shown while not `seen`; Send calls `onSeen`. */
  notice?: { seen: boolean; onSeen: () => void } | undefined;
  /** More lines for this request (v0.43.0: board setup's "using your key" and the reply's cap), after the size. */
  extra?: readonly string[];
  /** Why this can't be sent (v0.44.0: the summary's caps): said under the size, and Send is off. */
  blocked?: string | null;
}) {
  const headingId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => cancelRef.current?.focus(), []);
  const blockedId = useId();
  const send = () => {
    if (blocked !== null) return;
    if (notice && !notice.seen) notice.onSeen();
    onSend();
  };
  return (
    <section data-send-check="" aria-labelledby={headingId} className="flex flex-col gap-md text-sm text-fg">
      <h3 id={headingId} className="text-base font-semibold">
        Check before sending
      </h3>
      {notice && !notice.seen && <FirstTimeNotice />}
      <dl className="flex flex-col gap-xs">
        <dt className="text-fg-muted">{models.length === 1 ? "Model" : "Models"}</dt>
        <dd className="font-medium break-words">{models.map((m) => m.name).join(" and ")}</dd>
      </dl>
      <div className="flex flex-col gap-xs">
        <h4 className="text-fg-muted">What's sent</h4>
        <ul className="flex list-disc flex-col gap-xs pl-lg">
          {items.map((item) => (
            <li key={item} className="break-words">
              {item}
            </li>
          ))}
        </ul>
      </div>
      <p>
        <span className="text-fg-muted">Size: </span>
        About {plural(estimateTokens(chars), "token")} (an estimate: {plural(chars, "character")} ÷ 3)
      </p>
      {extra.map((line) => (
        <p key={line}>{line}</p>
      ))}
      <p>{WHERE_IT_GOES}</p>
      {blocked !== null && (
        <p id={blockedId} data-send-blocked="" className="font-medium text-status-error">
          {blocked}
        </p>
      )}
      <div className="flex flex-wrap gap-sm">
        <Button ref={cancelRef} onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" disabled={blocked !== null} aria-describedby={blocked !== null ? blockedId : undefined} onClick={send}>
          Send
        </Button>
      </div>
    </section>
  );
}
