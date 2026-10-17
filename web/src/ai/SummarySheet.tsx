import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { ClipboardList, Copy, FileText, Plus } from "lucide-react";
import { Button } from "../components/ui/button";
import { Sheet } from "../shell/Sheet";
import { useSettings } from "../settings/settingsStore";
import { useBoardUi } from "../canvas/uiStore";
import { findNote, type Board } from "../notes/board";
import type { ImportContent } from "../importer/parse";
import { useAi } from "./aiStore";
import { streamMessage } from "./client";
import { readApiKey } from "./keyStore";
import { describeError, type AiError } from "./messages";
import { LARGE_MODEL, SMALL_MODEL } from "./models";
import { SendCheck } from "./SendCheck";
import { parseSummaryReply } from "./summaryParse";
import { SUMMARY_IDLE_TIMEOUT_MS, SUMMARY_SYSTEM_PROMPT, summaryMaxTokens, summaryModel, summaryRequest, summaryUserMessage } from "./summaryPrompt";
import {
  SENTIMENT_NAMES,
  SUMMARY_TEXT,
  summaryColour,
  summaryContent,
  summaryFree,
  summaryHtml,
  summaryLimitReason,
  summaryMarkdown,
  summaryPlainText,
  summaryNeeds,
  summaryRoomReason,
} from "./summaryRules";
import { summaryScope, type ScopeSelection, type SummaryScope } from "./summaryScope";
import { useSummary, type StoredSummary } from "./summaryStore";

/*
 * Summary and sentiment (v0.44.0, 10c, AI part 3 of 4): the sheet the menu's "Summarise board" and
 * Properties' board summary open. Host only (the entries are off for everyone else, with the
 * reason). Pages: options (whole board or the selection, Deeper analysis), check before sending
 * (10a's), waiting (characters received, Cancel), the result (text only) and an error. The model
 * never touches the room: its reply is validated (summaryParse.ts), shown here as plain text, and
 * only Add to board puts anything on the board (one frame of notes, the paced add path, one undo).
 * The result is kept in memory (summaryStore) while the page is open, never stored.
 */

type Page = "options" | "check" | "waiting" | "result" | "error";

interface ShownError {
  title: string;
  message: string;
  next: string;
  retry: boolean;
  details: string | null;
}

function fromApi(error: AiError): ShownError {
  const text = describeError(error);
  return { title: text.title, message: text.message, next: error.kind === "truncated" ? SUMMARY_TEXT.truncatedNext : text.next, retry: text.retry, details: error.kind === "cancelled" ? null : text.details };
}
const UNREADABLE: ShownError = { ...SUMMARY_TEXT.unreadable, retry: true, details: null };

export interface SummarySheetProps {
  board: Board;
  /** My sealed notes during a silent round: never sent (the feature is off then anyway). */
  hidden: ReadonlySet<string>;
  /** Why this page can't send the board (not the host, a silent round, not connected), or null. */
  gate: string | null;
  /** Why Add to board can't run now (live from the board), or null. */
  addReason: string | null;
  /** Notes (every note, the hidden ones too) and frames on the board now. */
  used: { notes: number; frames: number };
  /** Places the content near the view; false if the board refused it. */
  place: (content: ImportContent) => boolean;
}

export function SummarySheet(props: SummarySheetProps) {
  const open = useSummary((s) => s.open);
  const hide = useSummary((s) => s.hide);
  useEffect(() => hide, [hide]);
  if (!open) return null;
  return (
    <Sheet title={SUMMARY_TEXT.title} icon={<ClipboardList />} page="ai-summary" onClose={hide}>
      <SummaryBody {...props} close={hide} />
    </Sheet>
  );
}

const snippet = (text: string) => {
  const line = text.replace(/\s+/g, " ").trim();
  return [...line].length > 40 ? `${[...line].slice(0, 39).join("")}…` : line;
};

function SummaryBody({ board, hidden, gate, addReason, used, place, close }: SummarySheetProps & { close: () => void }) {
  const ids = useId();
  const keyPlace = useAi((s) => s.place);
  const noticeSeen = useAi((s) => s.noticeSeen);
  const markNoticeSeen = useAi((s) => s.markNoticeSeen);
  const stored = useSummary((s) => s.summary);
  const stale = useSummary((s) => s.stale);
  const selectedNotes = useBoardUi((s) => s.selection);
  const selectedFrames = useBoardUi((s) => s.frames);
  const [page, setPage] = useState<Page>(() => (useSummary.getState().summary ? "result" : "options"));
  const [deeper, setDeeper] = useState(false);
  const hasSelection = selectedNotes.size + selectedFrames.size > 0;
  const [choice, setChoice] = useState<"whole" | "selection">(hasSelection ? "selection" : "whole");
  const [sending, setSending] = useState<SummaryScope | null>(null);
  const [chars, setChars] = useState(0);
  const [error, setError] = useState<ShownError | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [status, setStatus] = useState("");
  const running = useRef<AbortController | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const shown = useRef<Page>(page);

  // Closing the sheet (Esc, X, outside) stops a request still running; nothing is added.
  useEffect(
    () => () => {
      running.current?.abort();
      running.current = null;
      useSummary.getState().setPending(false);
    },
    [],
  );

  // Moving between pages: focus goes to the page's heading (the check page focuses its own Cancel).
  useEffect(() => {
    if (shown.current === page) return;
    shown.current = page;
    headingRef.current?.closest("[data-sheet-body]")?.scrollTo?.({ top: 0 });
    if (page !== "check") headingRef.current?.focus();
  }, [page]);

  const selection: ScopeSelection | null = hasSelection && choice === "selection" ? { notes: selectedNotes, frames: selectedFrames } : null;
  const wholeScope = summaryScope(board, { hidden });
  const selectionScope = hasSelection ? summaryScope(board, { selection: { notes: selectedNotes, frames: selectedFrames }, hidden }) : null;
  const scope = selection ? (selectionScope ?? wholeScope) : wholeScope;
  const empty = scope.noteCount === 0 ? SUMMARY_TEXT.empty : null;

  const fail = (shownError: ShownError) => {
    setError(shownError);
    setPage("error");
    setAnnouncement(`${shownError.title}. ${shownError.message}`);
  };

  const send = async () => {
    const target = sending;
    if (!target) return;
    const apiKey = readApiKey();
    if (!apiKey) return fail(fromApi({ kind: "no_key" }));
    const controller = new AbortController();
    running.current?.abort();
    running.current = controller;
    useSummary.getState().startSend();
    setChars(0);
    setError(null);
    setPage("waiting");
    setAnnouncement(SUMMARY_TEXT.sending);
    let receiving = false;
    const model = summaryModel(deeper);
    const reply = await streamMessage(summaryRequest(target, deeper), {
      apiKey,
      signal: controller.signal,
      idleTimeoutMs: SUMMARY_IDLE_TIMEOUT_MS,
      onProgress: (n) => {
        if (running.current !== controller) return;
        setChars(n);
        if (!receiving) {
          receiving = true;
          setAnnouncement(SUMMARY_TEXT.receiving);
        }
      },
    });
    // Closed, or superseded: nothing more to show.
    if (running.current !== controller) return;
    running.current = null;
    useSummary.getState().setPending(false);
    if (!reply.ok) return fail(fromApi(reply.error));
    const parsed = parseSummaryReply(reply.text, target);
    if (!parsed.ok) return fail(UNREADABLE);
    const summary: StoredSummary = { result: parsed.result, scope: target, at: Date.now(), model: model.name, input: reply.usage.inputTokens, output: reply.usage.outputTokens };
    useSummary.getState().setSummary(summary);
    setStatus("");
    setPage("result");
    setAnnouncement(SUMMARY_TEXT.ready(target.noteCount));
  };

  const cancelWaiting = () => {
    const controller = running.current;
    running.current = null;
    controller?.abort();
    useSummary.getState().setPending(false);
    fail(fromApi({ kind: "cancelled" }));
  };

  const heading = (text: string) => (
    <h3 ref={headingRef} tabIndex={-1} className="text-base font-semibold outline-none">
      {text}
    </h3>
  );

  let body: ReactNode;
  if (keyPlace === "none") {
    body = (
      <section data-summary-no-key="" className="flex flex-col gap-md text-sm">
        <h3 className="text-base font-semibold">{SUMMARY_TEXT.noKey}</h3>
        <p className="text-fg-muted">{SUMMARY_TEXT.noKeyBody}</p>
        <Button data-autofocus="" className="self-start" variant="primary" onClick={() => useSettings.getState().show()}>
          Open Settings
        </Button>
      </section>
    );
  } else if (page === "check" && sending) {
    const model = summaryModel(deeper);
    body = (
      <SendCheck
        models={[model]}
        items={[SUMMARY_TEXT.sent(sending.noteCount, sending.frames.length)]}
        chars={SUMMARY_SYSTEM_PROMPT.length + summaryUserMessage(sending).length}
        extra={[SUMMARY_TEXT.everyone, SUMMARY_TEXT.replyCap(summaryMaxTokens(sending.noteCount, sending.frames.length, deeper))]}
        notice={{ seen: noticeSeen, onSeen: markNoticeSeen }}
        blocked={gate ?? summaryLimitReason(sending)}
        onSend={() => void send()}
        onCancel={() => setPage("options")}
      />
    );
  } else if (page === "waiting") {
    body = (
      <section data-summary-waiting="" className="flex flex-col gap-md text-sm">
        {heading("Waiting for the summary")}
        <p className="tabular-nums">{chars === 0 ? SUMMARY_TEXT.waiting : SUMMARY_TEXT.progress(chars)}</p>
        <p className="text-fg-muted">{SUMMARY_TEXT.mayBill} Nothing is added to the board until you see the summary and choose Add to board.</p>
        <Button className="self-start" onClick={cancelWaiting}>
          Cancel
        </Button>
      </section>
    );
  } else if (page === "result" && stored) {
    body = (
      <Result
        summary={stored}
        board={board}
        headingRef={headingRef}
        blocked={stale ?? addReason ?? summaryRoomReason(summaryNeeds(stored.result), summaryFree(used))}
        add={(content) => {
          // Checked again at the moment of adding: the reasons and room are live from the board.
          const now = useSummary.getState().stale ?? addReason ?? summaryRoomReason(summaryNeeds(stored.result), summaryFree(used));
          if (now !== null) return;
          if (place(content)) {
            useSummary.getState().announce(SUMMARY_TEXT.added(content.notes.length));
            close();
          } else {
            setStatus(SUMMARY_TEXT.notAdded);
          }
        }}
        copy={() => {
          const text = summaryMarkdown(stored.result, stored.scope, new Date(stored.at));
          const done = navigator.clipboard?.writeText(text);
          if (!done) return setAnnouncement(SUMMARY_TEXT.copyFailed);
          done.then(
            () => setAnnouncement(SUMMARY_TEXT.copied),
            () => setAnnouncement(SUMMARY_TEXT.copyFailed),
          );
        }}
        copyDocs={() => {
          const at = new Date(stored.at);
          const text = summaryPlainText(stored.result, stored.scope, at);
          const clipboard = navigator.clipboard;
          // Formatted (HTML) and plain text together, so a document gets real headings and lists; else plain text only.
          const done =
            clipboard && "write" in clipboard && typeof ClipboardItem !== "undefined"
              ? clipboard
                  .write([new ClipboardItem({ "text/html": new Blob([summaryHtml(stored.result, stored.scope, at)], { type: "text/html" }), "text/plain": new Blob([text], { type: "text/plain" }) })])
                  .then(() => SUMMARY_TEXT.copiedDocs)
              : clipboard?.writeText(text).then(() => SUMMARY_TEXT.copiedPlain);
          if (!done) return setAnnouncement(SUMMARY_TEXT.copyFailed);
          done.then(setAnnouncement, () => setAnnouncement(SUMMARY_TEXT.copyFailed));
        }}
        again={() => setPage("options")}
        close={close}
        show={(id) => {
          close();
          useBoardUi.getState().requestReveal(id);
        }}
      />
    );
  } else if (page === "error" && error) {
    body = (
      <section data-summary-error="" role="alert" className="flex flex-col gap-sm rounded-md border border-status-error p-ms text-sm">
        <h3 ref={headingRef} tabIndex={-1} className="font-semibold text-status-error outline-none">
          {error.title}
        </h3>
        <p>{error.message}</p>
        <p>{error.next}</p>
        {error.details && (
          <details className="rounded-md border border-border">
            <summary className="flex min-h-touch cursor-pointer items-center px-ms font-medium">Details</summary>
            <p className="px-ms pb-ms font-mono text-xs break-all">{error.details}</p>
          </details>
        )}
        <div className="flex flex-wrap gap-sm">
          {error.retry && gate === null && sending && (
            <Button variant="primary" onClick={() => setPage("check")}>
              Retry
            </Button>
          )}
          <Button onClick={() => setPage("options")}>Back to the options</Button>
        </div>
      </section>
    );
  } else {
    const off = gate ?? empty;
    body = (
      <section data-summary-options="" className="flex flex-col gap-md text-sm">
        {heading(SUMMARY_TEXT.scopeLegend)}
        <p className="text-fg-muted">{SUMMARY_TEXT.intro}</p>
        {gate && (
          <p id={`${ids}-reason`} data-summary-reason="" className="font-medium">
            {gate}
          </p>
        )}
        {selectionScope ? (
          <fieldset data-summary-scope="" className="flex flex-col gap-xs">
            <legend className="sr-only">{SUMMARY_TEXT.scopeLegend}</legend>
            {(["whole", "selection"] as const).map((value) => (
              <label key={value} className="flex min-h-touch cursor-pointer items-center gap-sm">
                <input type="radio" name={`${ids}-scope`} value={value} checked={choice === value} onChange={() => setChoice(value)} className="size-5 accent-accent" />
                {value === "whole" ? SUMMARY_TEXT.whole(wholeScope.noteCount) : SUMMARY_TEXT.selection(selectionScope.noteCount)}
              </label>
            ))}
          </fieldset>
        ) : (
          <p data-summary-scope="" className="font-medium">
            {SUMMARY_TEXT.whole(wholeScope.noteCount)}
          </p>
        )}
        {empty && !gate && (
          <p id={`${ids}-empty`} className="font-medium">
            {empty}
          </p>
        )}
        <label className="flex min-h-touch cursor-pointer items-center gap-sm">
          <input
            type="checkbox"
            role="switch"
            data-summary-deeper=""
            checked={deeper}
            aria-describedby={`${ids}-deeper`}
            onChange={(e) => setDeeper(e.currentTarget.checked)}
            className="size-5 accent-accent"
          />
          <span className="font-medium">{SUMMARY_TEXT.deeper}</span>
        </label>
        <p id={`${ids}-deeper`} className="-mt-sm text-xs text-fg-muted">
          {SUMMARY_TEXT.deeperHint(SMALL_MODEL.name, LARGE_MODEL.name)}
        </p>
        <Button
          data-autofocus=""
          className="self-start"
          variant="primary"
          disabled={off !== null}
          aria-describedby={gate ? `${ids}-reason` : empty ? `${ids}-empty` : undefined}
          onClick={() => {
            setSending(scope);
            setPage("check");
          }}
        >
          Continue
        </Button>
      </section>
    );
  }

  return (
    <div data-summary-sheet="" className="flex flex-col gap-md pb-md">
      {body}
      <p data-summary-status="" role="status" className="text-sm text-fg-muted empty:hidden">
        {status}
      </p>
      <p data-summary-announcer="" role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </div>
  );
}

function Result({
  summary,
  board,
  headingRef,
  blocked,
  add,
  copy,
  copyDocs,
  again,
  close,
  show,
}: {
  summary: StoredSummary;
  board: Board;
  headingRef: RefObject<HTMLHeadingElement | null>;
  blocked: string | null;
  add: (content: ImportContent) => void;
  copy: () => void;
  copyDocs: () => void;
  again: () => void;
  close: () => void;
  show: (noteId: string) => void;
}) {
  const ids = useId();
  const { result, scope } = summary;
  const notesByRef = new Map([...scope.frames.flatMap((f) => f.notes), ...scope.loose].map((n) => [n.ref, n]));
  const titleOf = new Map(scope.frames.map((f) => [f.ref, f.title]));
  const s = result.sentiment;
  const chips = (refs: readonly string[]) =>
    refs.length === 0 ? null : (
      <div className="flex flex-wrap gap-xs">
        {refs.map((ref) => {
          const n = notesByRef.get(ref)!;
          const there = findNote(board, n.id) !== undefined;
          return (
            <Button key={ref} data-summary-chip="" className="h-auto min-h-touch max-w-full py-xs text-left whitespace-normal" disabled={!there} onClick={() => show(n.id)}>
              <span className="break-words">{there ? `${SUMMARY_TEXT.showNote}: ${snippet(n.text)}` : SUMMARY_TEXT.noteGone}</span>
            </Button>
          );
        })}
      </div>
    );
  const colours = board.notes.map((e) => e.note.color);
  const section = (title: string, children: ReactNode, data?: string) => (
    <section className="flex flex-col gap-xs" {...(data ? { [data]: "" } : {})}>
      <h4 className="font-semibold">{title}</h4>
      {children}
    </section>
  );
  return (
    <section data-summary-result="" className="flex flex-col gap-md text-sm break-words">
      <h3 ref={headingRef} tabIndex={-1} className="text-base font-semibold outline-none">
        Summary
      </h3>
      <p data-summary-caution="" className="rounded-md border border-status-warn bg-surface-muted p-ms font-medium">
        {SUMMARY_TEXT.caution}
      </p>
      <p data-summary-generated="" className="text-fg-muted">
        {SUMMARY_TEXT.generated(summary.at, scope.noteCount)}
      </p>
      {section("Overview", <p className="whitespace-pre-wrap">{result.overview}</p>)}
      {result.themes.length > 0 &&
        section(
          "Themes",
          <ul className="flex flex-col gap-sm">
            {result.themes.map((t, i) => (
              <li key={i} className="flex flex-col gap-xs rounded-md border border-border p-ms">
                <p>
                  <span className="font-semibold">{t.title}</span> <span className="text-fg-muted">({SUMMARY_TEXT.notes(t.refs.length)})</span>
                </p>
                {t.summary && <p>{t.summary}</p>}
                {chips(t.refs)}
              </li>
            ))}
          </ul>,
        )}
      {section(
        "Sentiment",
        <>
          <p data-summary-overall="">
            <span className="font-semibold">Overall: {s.overall ? SENTIMENT_NAMES[s.overall] : SENTIMENT_NAMES.notRated}.</span> {s.reason}
          </p>
          <ul data-summary-counts="" aria-label="Notes by sentiment (counted by the page)" className="flex flex-wrap gap-x-md gap-y-xs tabular-nums">
            {(["positive", "neutral", "negative", "mixed", "notRated"] as const).map((k) => (
              <li key={k}>
                {SENTIMENT_NAMES[k]} {s.counts[k]}
              </li>
            ))}
          </ul>
          {s.frames.length > 0 && (
            <ul data-summary-frames="" aria-label="By frame" className="flex flex-col gap-xs">
              {s.frames.map((f) => (
                <li key={f.ref}>
                  <span className="font-medium">
                    {titleOf.get(f.ref) || "Untitled frame"}: {f.label ? SENTIMENT_NAMES[f.label] : SENTIMENT_NAMES.notRated}
                  </span>
                  {f.reason && <span className="text-fg-muted"> ({f.reason})</span>}
                </li>
              ))}
            </ul>
          )}
        </>,
      )}
      {result.actions.length > 0 &&
        section(
          "Possible actions",
          <ul className="flex flex-col gap-sm">
            {result.actions.map((a, i) => (
              <li key={i} className="flex flex-col gap-xs rounded-md border border-border p-ms">
                <p>{a.text}</p>
                {chips(a.refs)}
              </li>
            ))}
          </ul>,
        )}
      {result.warnings.length > 0 && (
        <div data-summary-warnings="" className="flex flex-col gap-xs">
          <h4 className="font-semibold">Fixed in the reply</h4>
          <ul className="flex list-disc flex-col gap-xs pl-lg text-fg-muted">
            {result.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      )}
      <p className="text-fg-muted">
        {summary.model}. {SUMMARY_TEXT.tokens(summary.input, summary.output)}
      </p>
      <p className="text-xs text-fg-muted">{SUMMARY_TEXT.addOnly}</p>
      {blocked && (
        <p id={`${ids}-blocked`} data-summary-add-reason="" className="font-medium text-status-error">
          {SUMMARY_TEXT.blocked(blocked)}
        </p>
      )}
      <div className="flex flex-wrap gap-sm">
        <Button
          variant="primary"
          disabled={blocked !== null}
          aria-describedby={blocked ? `${ids}-blocked` : undefined}
          onClick={() => add(summaryContent(result, scope, summaryColour(colours)))}
        >
          <Plus />
          Add to board
        </Button>
        <Button onClick={copyDocs}>
          <FileText />
          Copy for documents
        </Button>
        <Button onClick={copy}>
          <Copy />
          Copy as Markdown
        </Button>
        <Button onClick={again}>Try again</Button>
        <Button onClick={close}>Close</Button>
      </div>
    </section>
  );
}

/** The board's polite line for an added summary (said once the sheet has closed). */
export function SummaryAnnouncer() {
  const text = useSummary((s) => s.announcement);
  return (
    <p data-summary-board-announcer="" role="status" aria-live="polite" className="sr-only">
      {text}
    </p>
  );
}

/** Properties' board summary (nothing selected, md and up): opens the sheet; off with the reason as text. */
export function SummarySection({ reason }: { reason: string | null }) {
  const id = useId();
  return (
    <section aria-labelledby={`${id}-h`} className="flex flex-col gap-xs border-t border-border pt-md">
      <h4 id={`${id}-h`} className="text-sm font-semibold">
        AI summary
      </h4>
      <p className="text-sm text-fg-muted">Overview, themes, sentiment and possible actions, written by AI from the board’s text. Read-only until you add it.</p>
      <Button
        data-summary-open=""
        className="self-start"
        disabled={reason !== null}
        aria-describedby={reason ? `${id}-r` : undefined}
        onClick={() => useSummary.getState().show()}
      >
        <ClipboardList />
        {SUMMARY_TEXT.title}…
      </Button>
      {reason && (
        <p id={`${id}-r`} className="text-xs text-fg-muted">
          {reason}
        </p>
      )}
    </section>
  );
}
