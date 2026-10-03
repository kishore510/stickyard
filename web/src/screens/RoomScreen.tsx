import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Check, Copy, LogOut, RefreshCw, RotateCcw, Send, UserRound } from "lucide-react";
import { MAX_NAME_LENGTH, MAX_PARTICIPANTS, MAX_TEXT_LENGTH, cleanName, isRoomCodeShape, type Participant } from "@stickyard/shared";
import { Button } from "../components/ui/button";
import { FieldError, Label } from "../components/ui/field";
import { Input } from "../components/ui/input";
import { cn } from "../lib/utils";
import { participantColourClass } from "../rooms/colours";
import { roomLink } from "../rooms/link";
import { useRoom } from "../rooms/useRoom";
import { Sheet } from "../shell/Sheet";
import { STORAGE_KEYS, readKey } from "../storage";

/*
 * A session: `#/room/<code>`. Names and text from the room are untrusted and only ever
 * rendered as React text, never as HTML.
 */

const PAGE = "mx-auto flex w-full max-w-content flex-1 flex-col gap-lg py-lg";
const HOME_LINK = "inline-flex min-h-touch items-center font-medium text-accent underline";

const goHome = () => {
  window.location.hash = "#/";
};

function Dot({ colourIndex }: { colourIndex: number }) {
  return <span aria-hidden="true" className={cn("inline-block size-dot shrink-0 rounded-full", participantColourClass(colourIndex))} />;
}

function Message({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className={cn(PAGE, "justify-center")}>
      <h1 className="text-2xl font-semibold">{title}</h1>
      {children}
    </div>
  );
}

function InvalidLink() {
  return (
    <Message title="This link isn’t valid">
      <p>It may have been mistyped or cut short. Ask the person who shared it to send it again.</p>
      <p>
        <a href="#/" className={HOME_LINK}>
          Go to the start page
        </a>
      </p>
    </Message>
  );
}

function NameSheet({
  busy,
  error,
  onJoin,
}: {
  busy: boolean;
  error: string | null;
  onJoin: (name: string) => void;
}) {
  const id = useId();
  const [name, setName] = useState(() => readKey(STORAGE_KEYS.name) ?? "");
  const [localError, setLocalError] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const shownError = localError ? "Type a name with at least one visible character." : error;

  useEffect(() => {
    if (shownError) inputRef.current?.focus();
  }, [shownError]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (cleanName(name) === null) return setLocalError(true);
    setLocalError(false);
    onJoin(name);
  };

  return (
    <Sheet title="Join session" icon={<UserRound />} page="join" onClose={goHome}>
      <form onSubmit={submit} className="flex flex-col gap-md pb-md" aria-busy={busy}>
        <div className="flex flex-col gap-sm">
          <Label htmlFor={`${id}-name`}>Your name</Label>
          <Input
            ref={inputRef}
            id={`${id}-name`}
            data-autofocus
            autoComplete="nickname"
            maxLength={MAX_NAME_LENGTH * 2}
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-describedby={`${id}-notice${shownError ? ` ${id}-error` : ""}`}
          />
          {shownError && <FieldError id={`${id}-error`}>{shownError}</FieldError>}
        </div>
        <p id={`${id}-notice`} className="rounded-md bg-surface-muted p-ms text-sm">
          Names aren’t verified: anyone with the link can join, and anyone can type any name. Up to {MAX_NAME_LENGTH}{" "}
          characters. Everyone in the session sees your name.
        </p>
        <Button type="submit" variant="primary" className="self-start" disabled={busy}>
          Join
        </Button>
      </form>
    </Sheet>
  );
}

function People({ people, you }: { people: Participant[]; you: Participant | null }) {
  return (
    <section aria-labelledby="people-heading" className="flex flex-col gap-sm">
      <h2 id="people-heading" className="text-lg font-semibold">
        People ({people.length} of {MAX_PARTICIPANTS})
      </h2>
      <ul className="flex flex-wrap gap-sm">
        {people.map((p) => (
          <li key={p.id} className="flex min-h-touch items-center gap-sm rounded-md border border-border bg-surface px-ms">
            <Dot colourIndex={p.colourIndex} />
            <span className="min-w-0 break-words">{p.name}</span>
            {p.id === you?.id && <span className="text-fg-muted"> (you)</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}

function EchoBox({ say, disabled }: { say: (text: string) => boolean; disabled: boolean }) {
  const id = useId();
  const [text, setText] = useState("");
  const [tooLong, setTooLong] = useState(false);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    if (say(text)) {
      setText("");
      setTooLong(false);
    } else setTooLong(!disabled);
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-sm">
      <Label htmlFor={`${id}-message`}>Message</Label>
      <div className="flex gap-sm">
        <Input
          id={`${id}-message`}
          autoComplete="off"
          maxLength={MAX_TEXT_LENGTH * 2}
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={disabled}
        />
        <Button type="submit" variant="primary" disabled={disabled}>
          <Send />
          Send
        </Button>
      </div>
      {tooLong && <FieldError>Messages can be up to {MAX_TEXT_LENGTH} characters.</FieldError>}
    </form>
  );
}

function CopyLink({ code }: { code: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const link = roomLink(code, window.location.origin, import.meta.env.BASE_URL);
  const copy = () => {
    const done = navigator.clipboard?.writeText(link);
    if (!done) return setState("failed");
    done.then(
      () => setState("copied"),
      () => setState("failed"),
    );
  };
  return (
    <>
      <Button onClick={copy}>
        {state === "copied" ? <Check /> : <Copy />}
        Copy link
      </Button>
      <p role="status" className="basis-full text-sm text-fg-muted">
        {state === "copied" && "Link copied. Anyone with it can join."}
        {state === "failed" && `Couldn’t copy. The link is: ${link}`}
      </p>
    </>
  );
}

export function RoomScreen({ code }: { code: string }) {
  const valid = isRoomCodeShape(code);
  const room = useRoom(code);
  const { view } = room;
  const [everJoined, setEverJoined] = useState(false);
  const lastName = useRef("");

  if (view.status === "joined" && !everJoined) setEverJoined(true);

  if (!valid || view.status === "invalid") return <InvalidLink />;
  if (view.status === "full") {
    return (
      <Message title="This session is full">
        <p>It already has {MAX_PARTICIPANTS} people. Try again when someone leaves.</p>
        <p>
          <a href="#/" className={HOME_LINK}>
            Go to the start page
          </a>
        </p>
      </Message>
    );
  }
  if (view.status === "reload") {
    return (
      <Message title="Please reload">
        <p>Stickyard has been updated. Reload the page to get the latest version, then join again.</p>
        <Button variant="primary" className="self-start" onClick={() => window.location.reload()}>
          <RefreshCw />
          Reload page
        </Button>
      </Message>
    );
  }

  const join = (name: string) => {
    lastName.current = name;
    room.join(name);
  };

  if (!everJoined) {
    const error = view.nameError
      ? "That name can’t be used. Use 1 to 24 visible characters."
      : view.status === "unreachable"
        ? "Couldn’t reach the Stickyard relay. Check your connection and try again."
        : null;
    return (
      <div className={PAGE}>
        <h1 className="text-2xl font-semibold">Session</h1>
        <p className="text-fg-muted">Type your name to join.</p>
        <NameSheet busy={view.status === "connecting"} error={error} onJoin={join} />
      </div>
    );
  }

  const live = view.status === "joined";
  return (
    <div className={PAGE}>
      <div className="flex flex-col gap-xs">
        <h1 className="text-2xl font-semibold">Session</h1>
        <p className="text-sm text-fg-muted">Everything typed here is shown to everyone in the session. Nothing is saved.</p>
      </div>

      <p aria-live="polite" className="sr-only">
        {view.announcement}
      </p>

      {!live && (
        <div role="alert" className="flex flex-col gap-sm rounded-md border border-status-error bg-surface p-md">
          <p className="font-medium">
            {view.status === "connecting" ? "Rejoining…" : "Connection lost. You’re no longer in the session."}
          </p>
          {view.status !== "connecting" && (
            <Button variant="primary" className="self-start" onClick={() => room.rejoin(lastName.current || (view.you?.name ?? ""))}>
              <RotateCcw />
              Rejoin
            </Button>
          )}
        </div>
      )}

      <People people={live ? view.participants : []} you={view.you} />

      <section aria-labelledby="echo-heading" className="flex flex-col gap-md">
        <h2 id="echo-heading" className="text-lg font-semibold">
          Echo
        </h2>
        <EchoBox say={room.say} disabled={!live} />
        {view.rateLimited && (
          <p role="status" className="text-sm text-status-warn">
            You’re sending messages quickly. Wait a moment, then try again.
          </p>
        )}
        <ol aria-label="Messages" className="flex flex-col gap-sm">
          {view.messages.map((m) => (
            <li key={m.key} className="flex flex-col gap-2xs rounded-md border border-border bg-surface p-ms">
              <span className="flex items-center gap-sm text-sm font-medium">
                <Dot colourIndex={m.colourIndex} />
                <span className="min-w-0 break-words">{m.name}</span>
              </span>
              <span className="break-words whitespace-pre-wrap">{m.text}</span>
            </li>
          ))}
        </ol>
        {view.messages.length === 0 && <p className="text-sm text-fg-muted">No messages yet. Say hello.</p>}
      </section>

      <div className="flex flex-wrap gap-sm">
        <CopyLink code={code} />
        <Button
          onClick={() => {
            room.leave();
            goHome();
          }}
        >
          <LogOut />
          Leave
        </Button>
      </div>
    </div>
  );
}
