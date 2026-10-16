import { ExternalLink } from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useAi, type LastTest } from "../ai/aiStore";
import { cleanKey, looksLikeAnthropicKey, readApiKey, type KeyPlace } from "../ai/keyStore";
import { describeError, type AiError } from "../ai/messages";
import { AI_MODELS, type AiModel } from "../ai/models";
import { SendCheck } from "../ai/SendCheck";
import { TEST_TEXT, testKey } from "../ai/testKey";
import { Button } from "../components/ui/button";
import { FieldError, Label } from "../components/ui/field";
import { Input } from "../components/ui/input";

/*
 * Settings > AI (your own key) (v0.42.0). Bring your own Anthropic key: the page calls
 * api.anthropic.com itself, so whoever presses an AI button pays with their own key. This section only
 * saves, tests and removes the key; no AI feature exists yet. Test key is the only call to Anthropic.
 * Confirmation steps (the Remember warning, check before sending) are pages inside the sheet.
 * The key is typed into the field, saved through the store and cleared from the field at once: the
 * UI and state show only where it is and its last four characters.
 */

export const CONSOLE_KEYS_URL = "https://platform.claude.com/settings/keys";

export const AI_TEXT = {
  heading: "AI (your own key)",
  intro:
    "AI features use your own Anthropic API key, and you pay Anthropic for what you use. Anything you choose to send goes to Anthropic's API. Nothing is sent until you press Send.",
  none: "No key saved.",
  session: (tail: string) => `Key saved for this session only (•••• ${tail}). It's forgotten when you reload or close the tab.`,
  device: (tail: string) => `Key remembered on this device (•••• ${tail}).`,
  warning:
    "It's stored unencrypted in this browser. Anyone who uses this browser, and other pages on this web address, could read it and spend on your Anthropic account. Only choose this on a device that's yours alone.",
  formatHint: "This doesn't look like an Anthropic API key (they start with sk-ant-). You can still save it.",
  empty: "Paste your key first.",
  blocked: "This browser won't store it, so the key is kept for this session only.",
} as const;

export function statusText(place: KeyPlace, tail: string): string {
  if (place === "session") return AI_TEXT.session(tail);
  if (place === "device") return AI_TEXT.device(tail);
  return AI_TEXT.none;
}

const pad = (n: number) => String(n).padStart(2, "0");
/** HH:MM in this device's time. */
export function clockTime(at: number): string {
  const d = new Date(at);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function lastTestText(test: LastTest): string {
  return `Last test ${test.ok ? "worked" : "failed"} at ${clockTime(test.at)}.`;
}

type Page = "main" | "remember" | "check";
/** Where focus goes when a page inside the sheet closes: back to what opened it. */
type Opener = "test" | "keep" | null;

interface TestError {
  error: AiError;
  failed: readonly AiModel[];
}

function ErrorBox({ failure, onRetry }: { failure: TestError; onRetry: () => void }) {
  const text = describeError(failure.error);
  const names = failure.failed.map((m) => m.name).join(" and ");
  return (
    <div data-ai-error="" role="alert" className="flex flex-col gap-sm rounded-md border border-status-error p-ms text-sm text-fg">
      <p className="font-semibold text-status-error">{names ? `Test failed for ${names}` : "Test failed"}</p>
      <p>
        <span className="font-medium">{text.title}.</span> {text.message}
      </p>
      <p>{text.next}</p>
      <details className="rounded-md border border-border">
        <summary className="flex min-h-touch cursor-pointer items-center px-ms font-medium">Details</summary>
        <p data-ai-error-details="" className="px-ms pb-ms font-mono text-xs break-all">
          {text.details}
        </p>
      </details>
      {/* Test key's Retry is always offered: token counting is free. */}
      <Button className="self-start" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

function RememberWarning({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) {
  const headingId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => cancelRef.current?.focus(), []);
  return (
    <section data-ai-remember-warning="" aria-labelledby={headingId} className="flex flex-col gap-md text-sm text-fg">
      <h3 id={headingId} className="text-base font-semibold">
        Remember the key on this device?
      </h3>
      <p role="note" className="rounded-md border border-status-error p-ms font-medium text-status-error">
        {AI_TEXT.warning}
      </p>
      <p>You can remove it at any time with Remove key, or by clearing this site's data.</p>
      <div className="flex flex-wrap gap-sm">
        <Button ref={cancelRef} onClick={onCancel}>
          Cancel
        </Button>
        <Button className="text-status-error" onClick={onConfirm}>
          Remember on this device
        </Button>
      </div>
    </section>
  );
}

function KeyForm({ replacing, onSaved, onCancel }: { replacing: boolean; onSaved: (message: string) => void; onCancel: () => void }) {
  const id = useId();
  const hintId = useId();
  const [draft, setDraft] = useState("");
  const [shown, setShown] = useState(false);
  const [empty, setEmpty] = useState(false);
  const save = useAi((s) => s.save);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (replacing) inputRef.current?.focus();
  }, [replacing]);

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const result = save(draft);
    if (!result.ok) {
      setEmpty(true);
      inputRef.current?.focus();
      return;
    }
    setDraft("");
    const { place } = useAi.getState();
    onSaved(
      result.fellBack
        ? `Key saved for this session only. ${AI_TEXT.blocked}`
        : place === "device"
          ? "Key remembered on this device."
          : "Key saved for this session only.",
    );
  };
  const cleaned = cleanKey(draft);

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-sm">
      <Label htmlFor={id}>Anthropic API key</Label>
      <div className="flex gap-sm">
        <Input
          ref={inputRef}
          id={id}
          data-ai-key-input=""
          type={shown ? "text" : "password"}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setEmpty(false);
          }}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          data-1p-ignore=""
          data-lpignore="true"
          aria-describedby={hintId}
          aria-invalid={empty || undefined}
          className="font-mono"
        />
        <Button aria-pressed={shown} onClick={() => setShown((v) => !v)}>
          {shown ? "Hide" : "Show"}
        </Button>
      </div>
      <p id={hintId} className="text-xs text-fg-muted">
        Create a key in the{" "}
        <a
          href={CONSOLE_KEYS_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2xs font-medium text-accent underline underline-offset-2"
        >
          Claude Console
          <ExternalLink aria-label="(opens in a new tab)" className="size-icon-sm" />
        </a>{" "}
        (API keys). Copy it and paste it here.
      </p>
      {cleaned !== "" && !looksLikeAnthropicKey(cleaned) && <p className="text-xs text-status-warn">{AI_TEXT.formatHint}</p>}
      {empty && <FieldError>{AI_TEXT.empty}</FieldError>}
      <div className="flex flex-wrap gap-sm">
        <Button variant="primary" onClick={() => submit()}>
          Save key
        </Button>
        {replacing && <Button onClick={onCancel}>Cancel</Button>}
      </div>
    </form>
  );
}

export function AiSection() {
  const headingId = useId();
  const place = useAi((s) => s.place);
  const tail = useAi((s) => s.tail);
  const keep = useAi((s) => s.keep);
  const keyVersion = useAi((s) => s.keyVersion);
  const lastTest = useAi((s) => s.lastTest);
  const [page, setPage] = useState<Page>("main");
  const [opener, setOpener] = useState<Opener>(null);
  const [replacing, setReplacing] = useState(false);
  const [announce, setAnnounce] = useState("");
  const [testing, setTesting] = useState(false);
  const [failure, setFailure] = useState<TestError | null>(null);
  const running = useRef<AbortController | null>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const testRef = useRef<HTMLButtonElement>(null);
  const keepDeviceRef = useRef<HTMLInputElement>(null);
  const sectionRef = useRef<HTMLElement>(null);

  // A key change ends a running test; its result is thrown away (runTest checks the version).
  useEffect(() => {
    running.current?.abort();
    running.current = null;
    setTesting(false);
    setFailure(null);
  }, [keyVersion]);
  useEffect(() => () => running.current?.abort(), []);

  // Back on the main page: focus returns to what opened the page that closed.
  useEffect(() => {
    if (page !== "main" || opener === null) return;
    (opener === "test" ? testRef.current : keepDeviceRef.current)?.focus();
    setOpener(null);
  }, [page, opener]);

  const show = (next: Page, from: Opener) => {
    setOpener(from);
    setPage(next);
    sectionRef.current?.closest("[data-sheet-body]")?.scrollTo?.({ top: 0 });
  };

  const runTest = async () => {
    const apiKey = readApiKey();
    if (!apiKey) {
      setFailure({ error: { kind: "no_key" }, failed: [] });
      return;
    }
    const version = useAi.getState().keyVersion;
    const controller = new AbortController();
    running.current = controller;
    setTesting(true);
    setFailure(null);
    setAnnounce("Testing the key.");
    const outcome = await testKey({ apiKey, signal: controller.signal });
    if (running.current !== controller || useAi.getState().keyVersion !== version) return;
    running.current = null;
    setTesting(false);
    if (outcome.kind === "cancelled") {
      setAnnounce("Test cancelled.");
      return;
    }
    const result: LastTest = { ok: outcome.kind === "passed", at: Date.now() };
    useAi.getState().setLastTest(result);
    if (outcome.kind === "failed") setFailure({ error: outcome.error, failed: outcome.failed });
    setAnnounce(lastTestText(result));
  };

  const cancelTest = () => running.current?.abort();

  const remove = () => {
    useAi.getState().remove();
    setReplacing(false);
    setAnnounce("Key removed.");
  };

  const setKeep = (choice: "session" | "device") => {
    const { fellBack } = useAi.getState().setKeep(choice);
    const now = useAi.getState();
    if (fellBack) setAnnounce(AI_TEXT.blocked);
    else if (now.place === "none")
      setAnnounce(choice === "device" ? "A key you save will be remembered on this device." : "A key you save will be kept for this session only.");
    else setAnnounce(choice === "device" ? "Key remembered on this device." : "Key kept for this session only.");
  };

  // One live region for every page inside the sheet, so it stays mounted (and heard) across pages.
  return (
    <div className="flex flex-col gap-md">
      {page === "remember" ? (
        <RememberWarning
          onCancel={() => show("main", "keep")}
          onConfirm={() => {
            setKeep("device");
            show("main", "keep");
          }}
        />
      ) : page === "check" ? (
        <SendCheck
          models={AI_MODELS}
          items={[
            `The word “${TEST_TEXT}”, once for each model, to Anthropic's free token-counting endpoint (count_tokens)`,
            "Your key, in a request header (never in the address or the message)",
          ]}
          chars={TEST_TEXT.length * AI_MODELS.length}
          onCancel={() => show("main", "test")}
          onSend={() => {
            show("main", null);
            void runTest();
          }}
        />
      ) : (
        mainPage()
      )}
      <p data-ai-announcer="" role="status" aria-live="polite" className="sr-only">
        {announce}
      </p>
    </div>
  );

  function mainPage() {
    const hasKey = place !== "none";
    const showForm = !hasKey || replacing;

    return (
      <section ref={sectionRef} data-ai-section="" aria-labelledby={headingId} className="flex flex-col gap-md text-sm text-fg">
        <h3 id={headingId} className="text-base font-semibold">
          {AI_TEXT.heading}
        </h3>
        <p>{AI_TEXT.intro}</p>

        <div className="flex flex-col gap-xs rounded-md border border-border bg-surface-muted p-ms">
          <p ref={statusRef} data-ai-status="" tabIndex={-1} className="font-medium break-words outline-none">
            {statusText(place, tail)}
          </p>
          {lastTest && (
            <p data-ai-last-test="" className={lastTest.ok ? "text-status-ok" : "text-status-error"}>
              {lastTestText(lastTest)}
            </p>
          )}
        </div>

        {showForm ? (
          <KeyForm
            replacing={replacing}
            onSaved={(message) => {
              setReplacing(false);
              setAnnounce(message);
              requestAnimationFrame(() => statusRef.current?.focus());
            }}
            onCancel={() => {
              setReplacing(false);
              requestAnimationFrame(() => statusRef.current?.focus());
            }}
          />
        ) : (
          <div className="flex flex-wrap gap-sm">
            {testing ? (
              <div data-ai-testing="" className="flex flex-wrap items-center gap-sm">
                <span className="text-fg-muted">Testing the key…</span>
                <Button onClick={cancelTest}>Cancel</Button>
              </div>
            ) : (
              <Button ref={testRef} variant="primary" onClick={() => show("check", "test")}>
                Test key
              </Button>
            )}
            <Button onClick={() => setReplacing(true)}>Replace key</Button>
            <Button className="text-status-error" onClick={remove}>
              Remove key
            </Button>
          </div>
        )}

        {failure && !testing && <ErrorBox failure={failure} onRetry={() => void runTest()} />}

        <fieldset className="flex flex-col gap-sm">
          <legend className="mb-sm font-medium">Keep the key</legend>
          <label className="flex min-h-touch cursor-pointer items-start gap-ms rounded-md border border-border bg-surface p-ms">
            <input
              type="radio"
              name="ai-keep"
              value="session"
              checked={keep === "session"}
              onChange={() => setKeep("session")}
              className="mt-2xs size-icon shrink-0 accent-accent"
            />
            <span className="flex flex-col">
              <span className="font-medium">This session only</span>
              <span className="text-fg-muted">Kept in this tab's memory and forgotten when you reload or close it. Nothing is stored.</span>
            </span>
          </label>
          <label className="flex min-h-touch cursor-pointer items-start gap-ms rounded-md border border-border bg-surface p-ms">
            <input
              ref={keepDeviceRef}
              type="radio"
              name="ai-keep"
              value="device"
              checked={keep === "device"}
              onChange={() => show("remember", "keep")}
              className="mt-2xs size-icon shrink-0 accent-accent"
            />
            <span className="flex flex-col">
              <span className="font-medium">Remember on this device</span>
              <span className="text-fg-muted">Stored unencrypted in this browser until you remove it.</span>
            </span>
          </label>
        </fieldset>
      </section>
    );
  }
}
