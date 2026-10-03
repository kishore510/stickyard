import { useId, useState, type FormEvent } from "react";
import { Link2, LogIn, MonitorSmartphone, Plus, StickyNote, type LucideIcon } from "lucide-react";
import { MAX_PASSCODE_LENGTH } from "@stickyard/shared";
import { StickyardMark } from "../brand/StickyardMark";
import { Button } from "../components/ui/button";
import { FieldError, Label } from "../components/ui/field";
import { Input } from "../components/ui/input";
import { WORKER_URL } from "../config";
import { browserFetch, createErrorMessage, createRoom } from "../rooms/api";
import { parseJoinInput, roomHash } from "../rooms/link";
import { ConnectionStatus } from "./ConnectionStatus";

/* Compact on phones (so both actions fit above the fold at 360 x 640), roomier from md up. */
const CARD = "flex flex-col gap-sm rounded-lg border border-border bg-surface p-md shadow-sm md:gap-md md:p-lg";
/** The field and its button share a row (the button keeps its label; the field takes the rest). */
const FIELD_ROW = "flex items-start gap-sm";

/**
 * Start a session. The passcode lives only in this component's state: it is cleared as soon
 * as it is sent, never written to browser storage, and sent only in the request body.
 */
function StartCard() {
  const id = useId();
  const [passcode, setPasscode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const value = passcode;
    setPasscode("");
    if (!value || busy) return;
    setBusy(true);
    setError(null);
    const result = await createRoom(WORKER_URL, value, browserFetch);
    setBusy(false);
    if (result.ok) window.location.hash = roomHash(result.code);
    else setError(createErrorMessage(result));
  };

  return (
    <section aria-labelledby={`${id}-heading`} className={CARD}>
      <h2 id={`${id}-heading`} className="text-lg font-semibold">
        Start a session
      </h2>
      <p className="text-sm text-fg-muted">Starting a session needs the create passcode. Joining one doesn’t.</p>
      <form onSubmit={submit} className="flex flex-col gap-sm" aria-busy={busy}>
        <Label htmlFor={`${id}-passcode`}>Create passcode</Label>
        <div className={FIELD_ROW}>
          <Input
            id={`${id}-passcode`}
            type="password"
            autoComplete="current-password"
            maxLength={MAX_PASSCODE_LENGTH}
            required
            value={passcode}
            onChange={(e) => setPasscode(e.target.value)}
            aria-describedby={error ? `${id}-error` : undefined}
            className="min-w-0 flex-1"
          />
          <Button type="submit" variant="primary" disabled={busy}>
            <Plus />
            Start session
          </Button>
        </div>
        {error && <FieldError id={`${id}-error`}>{error}</FieldError>}
      </form>
    </section>
  );
}

function JoinCard() {
  const id = useId();
  const [value, setValue] = useState("");
  const [error, setError] = useState(false);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const code = parseJoinInput(value);
    if (!code) return setError(true);
    setError(false);
    window.location.hash = roomHash(code);
  };

  return (
    <section aria-labelledby={`${id}-heading`} className={CARD}>
      <h2 id={`${id}-heading`} className="text-lg font-semibold">
        Join a session
      </h2>
      <form onSubmit={submit} className="flex flex-col gap-sm">
        <Label htmlFor={`${id}-link`}>Session link or code</Label>
        <div className={FIELD_ROW}>
          <Input
            id={`${id}-link`}
            type="text"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            maxLength={2000}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-describedby={error ? `${id}-error` : undefined}
            className="min-w-0 flex-1"
          />
          <Button type="submit" variant="secondary">
            <LogIn />
            Join
          </Button>
        </div>
        {error && (
          <FieldError id={`${id}-error`}>That doesn’t look like a Stickyard link or code. Check you copied all of it.</FieldError>
        )}
      </form>
    </section>
  );
}

/** What works today, one line each. Only things that exist. */
const POINTS: readonly { icon: LucideIcon; text: string }[] = [
  { icon: Link2, text: "Join with a link and a typed name." },
  { icon: StickyNote, text: "Add, move and style notes together, live." },
  { icon: MonitorSmartphone, text: "Works on a phone and a laptop." },
];

/**
 * The welcome screen (#/): the mark, the wordmark (live text, the page's one h1), a tagline, the
 * two actions, what works today, and the relay's status. Phones: a compact column with the mark
 * beside the wordmark, so both actions fit without scrolling. From md up: the mark above the
 * text and the actions side by side. Nothing here is stored.
 */
export function HomeScreen() {
  return (
    <div className="mx-auto flex w-full max-w-content flex-1 flex-col justify-center gap-md py-md md:max-w-welcome md:gap-lg md:py-lg">
      <header className="flex items-center gap-md md:flex-col md:gap-sm md:text-center">
        <StickyardMark className="w-brand-mark shrink-0 md:w-brand-mark-lg" />
        <div className="flex min-w-0 flex-col gap-xs">
          <h1 className="text-2xl font-bold tracking-tight md:text-display">Stickyard</h1>
          <p className="text-sm text-fg-muted md:text-base">Sticky-note boards for workshops and retros. No accounts: open a link, type a name.</p>
        </div>
      </header>
      <div className="grid gap-md md:grid-cols-2">
        <StartCard />
        <JoinCard />
      </div>
      <ul data-welcome-points className="flex flex-col gap-xs text-sm text-fg-muted md:flex-row md:flex-wrap md:justify-center md:gap-x-lg">
        {POINTS.map(({ icon: Icon, text }) => (
          <li key={text} className="flex items-center gap-sm">
            <Icon aria-hidden="true" className="size-icon-sm shrink-0" />
            {text}
          </li>
        ))}
      </ul>
      <ConnectionStatus />
    </div>
  );
}
