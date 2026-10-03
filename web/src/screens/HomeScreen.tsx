import { useId, useState, type FormEvent } from "react";
import { LogIn, Plus } from "lucide-react";
import { MAX_PASSCODE_LENGTH } from "@stickyard/shared";
import { Button } from "../components/ui/button";
import { FieldError, Label } from "../components/ui/field";
import { Input } from "../components/ui/input";
import { WORKER_URL } from "../config";
import { browserFetch, createErrorMessage, createRoom } from "../rooms/api";
import { parseJoinInput, roomHash } from "../rooms/link";
import { ConnectionStatus } from "./ConnectionStatus";

const CARD = "flex flex-col gap-md rounded-lg border border-border bg-surface p-lg shadow-sm";

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
        <Input
          id={`${id}-passcode`}
          type="password"
          autoComplete="current-password"
          maxLength={MAX_PASSCODE_LENGTH}
          required
          value={passcode}
          onChange={(e) => setPasscode(e.target.value)}
          aria-describedby={error ? `${id}-error` : undefined}
        />
        {error && <FieldError id={`${id}-error`}>{error}</FieldError>}
        <Button type="submit" variant="primary" className="self-start" disabled={busy}>
          <Plus />
          Start session
        </Button>
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
        />
        {error && (
          <FieldError id={`${id}-error`}>That doesn’t look like a Stickyard link or code. Check you copied all of it.</FieldError>
        )}
        <Button type="submit" variant="secondary" className="self-start">
          <LogIn />
          Join
        </Button>
      </form>
    </section>
  );
}

export function HomeScreen() {
  return (
    <div className="mx-auto flex w-full max-w-content flex-1 flex-col justify-center gap-lg py-lg">
      <div className="flex flex-col gap-xs">
        <h1 className="text-2xl font-semibold tracking-tight">Stickyard</h1>
        <p className="text-fg-muted">Real-time sticky notes for workshops and retros. This version is an echo room.</p>
      </div>
      <StartCard />
      <JoinCard />
      <ConnectionStatus />
    </div>
  );
}
