import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { WandSparkles } from "lucide-react";
import { Button } from "../components/ui/button";
import { Textarea } from "../components/ui/textarea";
import { Sheet } from "../shell/Sheet";
import { useSettings } from "../settings/settingsStore";
import { FRAME_COLOR_NAMES } from "../frames/style";
import { NOTE_COLOR_CLASSES, NOTE_COLOR_NAMES } from "../notes/colours";
import { importRoomFails, type ImportContent, type ImportCounts } from "../importer/parse";
import { cn } from "../lib/utils";
import { useAi } from "./aiStore";
import { streamMessage } from "./client";
import { readApiKey } from "./keyStore";
import { describeError, type AiError } from "./messages";
import { SendCheck } from "./SendCheck";
import { SETUP_EXAMPLES, SETUP_IDLE_TIMEOUT_MS, SETUP_LIMITS, SETUP_MAX_TOKENS, SETUP_MODEL, SETUP_SYSTEM_PROMPT, setupRequest } from "./setupPrompt";
import { parseSetupReply, type PreviewNote, type SetupResult } from "./setupParse";
import { SETUP_TEXT, setupFree, setupFullReason } from "./setupRules";
import { useSetup } from "./setupStore";

/*
 * Board setup from a prompt (v0.43.0, 10b, AI part 2 of 4): the sheet the menu's item and the empty
 * board's button open. Pages: the text box (with example chips), check before sending (10a's),
 * waiting (characters received, Cancel), the preview (by frame, counts, what was fixed, tokens) and
 * an error. The model never touches the room: it returns JSON, setupParse checks it, the person
 * previews it, and only Add to board places it (`place`, the Import path, one undo step). Model
 * text is untrusted and shown only as text. Who can use it is checked when the sheet opens and again
 * at Add to board (`reason` and `used` are live from the board), so a lock, a silent round or a
 * full board that arrived while waiting is caught and said.
 */

type Page = "describe" | "check" | "waiting" | "preview" | "error";

interface ShownError {
  title: string;
  message: string;
  next: string;
  retry: boolean;
  details: string | null;
}

/** An API error as the sheet shows it; a reply cut short says to ask for fewer items. */
function fromApi(error: AiError): ShownError {
  const text = describeError(error);
  return { title: text.title, message: text.message, next: error.kind === "truncated" ? SETUP_TEXT.truncatedNext : text.next, retry: text.retry, details: error.kind === "cancelled" ? null : text.details };
}
const UNREADABLE: ShownError = { ...SETUP_TEXT.unreadable, retry: true, details: null };

export function SetupSheet({
  reason,
  used,
  place,
}: {
  /** Why it can't run now (not connected, locked, silent round, busy), or null. */
  reason: string | null;
  /** What's on the board now (notes: every note, the hidden ones too). */
  used: ImportCounts;
  /** Places the content (a free spot near the view, selected, the view moved if needed); false if the board refused it. */
  place: (content: ImportContent) => boolean;
}) {
  const open = useSetup((s) => s.open);
  const hide = useSetup((s) => s.hide);
  useEffect(() => hide, [hide]);
  if (!open) return null;
  return (
    <Sheet title={SETUP_TEXT.title} icon={<WandSparkles />} page="ai-setup" onClose={hide}>
      <SetupBody reason={reason} used={used} place={place} close={hide} />
    </Sheet>
  );
}

function SetupBody({ reason, used, place, close }: { reason: string | null; used: ImportCounts; place: (content: ImportContent) => boolean; close: () => void }) {
  const ids = useId();
  const keyPlace = useAi((s) => s.place);
  const noticeSeen = useAi((s) => s.noticeSeen);
  const markNoticeSeen = useAi((s) => s.markNoticeSeen);
  const draft = useSetup((s) => s.draft);
  const setDraft = useSetup((s) => s.setDraft);
  const [page, setPage] = useState<Page>("describe");
  const [chars, setChars] = useState(0);
  const [result, setResult] = useState<{ setup: SetupResult; input: number; output: number } | null>(null);
  const [error, setError] = useState<ShownError | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [status, setStatus] = useState("");
  const running = useRef<AbortController | null>(null);
  const usedRef = useRef(used);
  usedRef.current = used;
  const headingRef = useRef<HTMLHeadingElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const shown = useRef<Page>("describe");

  // Closing the sheet (Esc, X, outside) stops a request still running; nothing is added.
  useEffect(
    () => () => {
      running.current?.abort();
      running.current = null;
    },
    [],
  );

  // Moving between pages: focus goes to the text box or the page's heading (the check page focuses its own Cancel).
  useEffect(() => {
    if (shown.current === page) return;
    shown.current = page;
    textRef.current?.closest("[data-sheet-body]")?.scrollTo?.({ top: 0 });
    headingRef.current?.closest("[data-sheet-body]")?.scrollTo?.({ top: 0 });
    if (page === "describe") textRef.current?.focus();
    else if (page !== "check") headingRef.current?.focus();
  }, [page]);

  const free = setupFree(used);
  const gate = reason ?? setupFullReason(free);
  const description = draft.trim();

  const fail = (shownError: ShownError) => {
    setError(shownError);
    setPage("error");
    setAnnouncement(`${shownError.title}. ${shownError.message}`);
  };

  const send = async () => {
    const apiKey = readApiKey();
    if (!apiKey) return fail(fromApi({ kind: "no_key" }));
    const controller = new AbortController();
    running.current?.abort();
    running.current = controller;
    setChars(0);
    setResult(null);
    setError(null);
    setPage("waiting");
    setAnnouncement(SETUP_TEXT.sending);
    let receiving = false;
    const reply = await streamMessage(setupRequest(draft), {
      apiKey,
      signal: controller.signal,
      idleTimeoutMs: SETUP_IDLE_TIMEOUT_MS,
      onProgress: (n) => {
        if (running.current !== controller) return;
        setChars(n);
        if (!receiving) {
          receiving = true;
          setAnnouncement(SETUP_TEXT.receiving);
        }
      },
    });
    // Closed, or superseded: nothing more to show.
    if (running.current !== controller) return;
    running.current = null;
    if (!reply.ok) return fail(fromApi(reply.error));
    const parsed = parseSetupReply(reply.text, setupFree(usedRef.current));
    if (!parsed.ok) return fail(UNREADABLE);
    const { frames, notes } = parsed.result.content;
    setResult({ setup: parsed.result, input: reply.usage.inputTokens, output: reply.usage.outputTokens });
    setStatus("");
    setPage("preview");
    setAnnouncement(SETUP_TEXT.previewReady(frames.length, notes.length));
  };

  const cancelWaiting = () => {
    const controller = running.current;
    running.current = null;
    controller?.abort();
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
      <section data-setup-no-key="" className="flex flex-col gap-md text-sm">
        <h3 className="text-base font-semibold">{SETUP_TEXT.noKey}</h3>
        <p className="text-fg-muted">{SETUP_TEXT.noKeyBody}</p>
        <Button data-autofocus="" className="self-start" variant="primary" onClick={() => useSettings.getState().show()}>
          Open Settings
        </Button>
      </section>
    );
  } else if (page === "check") {
    const sentChars = SETUP_SYSTEM_PROMPT.length + (setupRequest(draft).messages[0]?.content.length ?? 0);
    body = (
      <SendCheck
        models={[SETUP_MODEL]}
        items={[SETUP_TEXT.sent]}
        chars={sentChars}
        extra={[SETUP_TEXT.yourKey, SETUP_TEXT.replyCap(SETUP_MAX_TOKENS)]}
        notice={{ seen: noticeSeen, onSeen: markNoticeSeen }}
        onSend={() => void send()}
        onCancel={() => setPage("describe")}
      />
    );
  } else if (page === "waiting") {
    body = (
      <section data-setup-waiting="" className="flex flex-col gap-md text-sm">
        {heading("Waiting for the reply")}
        <p className="tabular-nums">{chars === 0 ? SETUP_TEXT.waiting : SETUP_TEXT.progress(chars)}</p>
        <p className="text-fg-muted">Nothing is added to the board until you see a preview and choose Add to board.</p>
        <Button className="self-start" onClick={cancelWaiting}>
          Cancel
        </Button>
      </section>
    );
  } else if (page === "preview" && result) {
    const { setup } = result;
    const fails = importRoomFails(setup.content, used);
    const blocked = reason ?? (fails.length > 0 ? SETUP_TEXT.noRoom(fails) : null);
    const add = () => {
      if (blocked !== null) return;
      if (place(setup.content)) {
        useSetup.getState().announce(SETUP_TEXT.added(setup.content.frames.length, setup.content.notes.length));
        close();
      } else {
        setStatus(SETUP_TEXT.notAdded);
      }
    };
    body = (
      <section data-setup-preview="" className="flex flex-col gap-md text-sm">
        {heading("Preview")}
        <p className="font-medium">{SETUP_TEXT.counts(setup.content.frames.length, setup.content.notes.length)}</p>
        <ul className="flex flex-col gap-md" aria-label="What will be added">
          {setup.frames.map((f) => (
            <li key={f.ref} className="overflow-hidden rounded-md border border-border">
              <p className="flex flex-wrap items-baseline gap-x-sm px-ms py-xs" style={{ backgroundColor: `var(--sy-frame-${f.color}-header)`, color: "var(--sy-frame-title)" }}>
                <span data-setup-frame-title="" className="font-semibold break-words">
                  {f.title || "Untitled frame"}
                </span>
                <span className="text-xs">({FRAME_COLOR_NAMES[f.color]} frame)</span>
              </p>
              <NoteList notes={f.notes} empty="No notes in this frame." />
            </li>
          ))}
          {setup.loose.length > 0 && (
            <li className="rounded-md border border-dashed border-border">
              <p className="px-ms py-xs font-semibold">Not in a frame</p>
              <NoteList notes={setup.loose} empty="" />
            </li>
          )}
        </ul>
        {setup.warnings.length > 0 && (
          <div data-setup-warnings="" className="flex flex-col gap-xs">
            <h4 className="font-semibold">Fixed in the reply</h4>
            <ul className="flex list-disc flex-col gap-xs pl-lg text-fg-muted">
              {setup.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </div>
        )}
        <p className="text-fg-muted">{SETUP_TEXT.tokens(result.input, result.output)}</p>
        <p className="text-xs text-fg-muted">Add to board only adds: nothing on the board is replaced or cleared. One Undo removes all of it.</p>
        {blocked && (
          <p id={`${ids}-blocked`} data-setup-blocked="" className="text-sm font-medium text-status-error">
            {SETUP_TEXT.blocked(blocked)}
          </p>
        )}
        <div className="flex flex-wrap gap-sm">
          <Button variant="primary" disabled={blocked !== null} aria-describedby={blocked ? `${ids}-blocked` : undefined} onClick={add}>
            Add to board
          </Button>
          <Button onClick={() => setPage("describe")}>Try again</Button>
          <Button onClick={close}>Cancel</Button>
        </div>
      </section>
    );
  } else if (page === "error" && error) {
    body = (
      <section data-setup-error="" role="alert" className="flex flex-col gap-sm rounded-md border border-status-error p-ms text-sm">
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
          {error.retry && gate === null && (
            <Button variant="primary" onClick={() => setPage("check")}>
              Retry
            </Button>
          )}
          <Button onClick={() => setPage("describe")}>Edit the description</Button>
        </div>
      </section>
    );
  } else {
    const room = SETUP_TEXT.room(free);
    const off = gate !== null || description === "";
    body = (
      <section data-setup-describe="" className="flex flex-col gap-md text-sm">
        <p className="text-fg-muted">{SETUP_TEXT.intro}</p>
        {gate && (
          <p id={`${ids}-reason`} data-setup-reason="" className="font-medium">
            {gate}
          </p>
        )}
        <div className="flex flex-col gap-xs">
          <label htmlFor={`${ids}-text`} className="font-medium">
            {SETUP_TEXT.label}
          </label>
          <Textarea
            ref={textRef}
            id={`${ids}-text`}
            data-setup-text=""
            data-autofocus=""
            rows={5}
            maxLength={SETUP_LIMITS.description}
            value={draft}
            aria-describedby={`${ids}-count`}
            onChange={(e) => setDraft(e.currentTarget.value)}
          />
          <p id={`${ids}-count`} className="self-end text-xs text-fg-muted tabular-nums">
            <span className="sr-only">Characters used: </span>
            {SETUP_TEXT.counter(draft.length)}
          </p>
        </div>
        <div className="flex flex-col gap-xs">
          <h3 className="font-medium text-fg-muted">{SETUP_TEXT.examples}</h3>
          <div className="flex flex-col gap-xs">
            {SETUP_EXAMPLES.map((example) => (
              <Button key={example} data-setup-example="" className="h-auto min-h-touch shrink justify-start py-xs text-left whitespace-normal" onClick={() => setDraft(example)}>
                {example}
              </Button>
            ))}
          </div>
        </div>
        {room && <p className="text-fg-muted">{room}</p>}
        <Button className="self-start" variant="primary" disabled={off} aria-describedby={gate ? `${ids}-reason` : undefined} onClick={() => setPage("check")}>
          Continue
        </Button>
      </section>
    );
  }

  return (
    <div data-setup-sheet="" className="flex flex-col gap-md pb-md">
      {body}
      <p data-setup-status="" role="status" className="text-sm text-fg-muted empty:hidden">
        {status}
      </p>
      <p data-setup-announcer="" role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </div>
  );
}

function NoteList({ notes, empty }: { notes: readonly PreviewNote[]; empty: string }) {
  if (notes.length === 0) return empty ? <p className="px-ms py-xs text-fg-muted">{empty}</p> : null;
  return (
    <ul className="flex flex-col gap-xs p-xs">
      {notes.map((n) => (
        <li key={n.ref} className={cn("rounded-sm border border-border px-sm py-xs whitespace-pre-wrap break-words text-note-fg", NOTE_COLOR_CLASSES[n.color])}>
          <span className="sr-only">{NOTE_COLOR_NAMES[n.color]} note: </span>
          {n.text || <span className="italic">(empty note)</span>}
        </li>
      ))}
    </ul>
  );
}

/** The board's polite line for an added set-up (said once the sheet has closed). */
export function SetupAnnouncer() {
  const text = useSetup((s) => s.announcement);
  return (
    <p data-setup-board-announcer="" role="status" aria-live="polite" className="sr-only">
      {text}
    </p>
  );
}

/** The empty board's prompt (v0.43.0): only while nothing is on the board. */
export function EmptyBoardSetup({ onOpen }: { onOpen: () => void }) {
  return (
    // Centred on the canvas, clear of the notice strips at the top and the bars at the bottom; only the card takes pointer input.
    <div data-empty-board="" className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center px-md">
      <div className="pointer-events-auto flex max-w-sheet flex-col items-center gap-sm rounded-md border border-border bg-surface p-md text-center text-sm text-fg shadow-md">
        <p>{SETUP_TEXT.emptyBoard}</p>
        <Button variant="primary" onClick={onOpen}>
          <WandSparkles />
          {SETUP_TEXT.title}
        </Button>
      </div>
    </div>
  );
}

