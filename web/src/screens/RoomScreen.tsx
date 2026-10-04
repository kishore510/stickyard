import { Suspense, lazy, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Home, RefreshCw, UserRound } from "lucide-react";
import { MAX_NAME_LENGTH, MAX_PARTICIPANTS, cleanName, isRoomCodeShape } from "@stickyard/shared";
import { Button } from "../components/ui/button";
import { FieldError, Label } from "../components/ui/field";
import { Input } from "../components/ui/input";
import { useMediaQuery } from "../lib/useMediaQuery";
import { cn } from "../lib/utils";
import { authorName } from "../notes/label";
import { NoteEditor } from "../notes/NoteEditor";
import { useRoomUi } from "../rooms/roomStore";
import { EXPIRED_TEXT, type RoomView } from "../rooms/session";
import { useRoom } from "../rooms/useRoom";
import { Sheet } from "../shell/Sheet";
import { STORAGE_KEYS, readKey } from "../storage";
import { MEDIA } from "../styles/breakpoints";

/** The board and its tools (React Flow), in its own chunk; loading starts when a room opens. */
const loadBoard = () => import("../canvas/RoomBoard");
const RoomBoard = lazy(loadBoard);
/*
 * A session: `#/room/<code>`. Names, messages and note text from the room are untrusted and
 * only ever rendered as React text, never as HTML.
 */

/** Pages shown in a room before the board (joining, errors): the shell gives rooms no padding. */
const PAGE = "sy-safe-x mx-auto flex w-full max-w-content flex-1 flex-col gap-lg overflow-y-auto py-lg";

type Room = ReturnType<typeof useRoom>;

/** Shares the room with the top bar, menu and Participants sheet (rooms/roomStore.ts). */
function PublishRoom({ code, view, room }: { code: string; view: RoomView; room: Room }) {
  const publish = useRoomUi((s) => s.publish);
  const latest = useRef(room);
  latest.current = room;
  const live = view.status === "joined";
  const { you, yourIds, participants, messages, rateLimited } = view;
  useEffect(() => {
    publish({
      code,
      you,
      yourIds,
      participants,
      live,
      messages,
      rateLimited,
      say: (text) => latest.current.say(text),
      leave: () => latest.current.leave(),
    });
  }, [publish, code, you, yourIds, participants, live, messages, rateLimited]);
  useEffect(() => () => publish(null), [publish]);
  return null;
}

const HOME_LINK = "inline-flex min-h-touch items-center font-medium text-accent underline";

const goHome = () => {
  window.location.hash = "#/";
};

function Message({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className={cn(PAGE, "justify-center")}>
      <h1 className="text-2xl font-semibold">{title}</h1>
      {children}
    </div>
  );
}

/**
 * The relay closed the socket with 4410: the session expired (rooms/session.ts). Its board is
 * gone, so none is shown; the sentence is announced politely, and there is no Rejoin.
 */
function Expired() {
  return (
    <div className={cn(PAGE, "justify-center")} data-session-expired>
      <h1 className="text-2xl font-semibold">{EXPIRED_TEXT.title}</h1>
      <p role="status" aria-live="polite" aria-atomic="true">
        {EXPIRED_TEXT.body}
      </p>
      <Button variant="primary" className="self-start" onClick={goHome}>
        <Home />
        {EXPIRED_TEXT.home}
      </Button>
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

export function RoomScreen({ code }: { code: string }) {
  const valid = isRoomCodeShape(code);
  const room = useRoom(code);
  const { view } = room;
  const [everJoined, setEverJoined] = useState(false);
  // From md up the Properties panel is the note editor; the sheet is for phones.
  const wide = useMediaQuery(MEDIA.tablet);

  useEffect(() => {
    void loadBoard();
  }, []);

  if (view.status === "joined" && !everJoined) setEverJoined(true);

  if (!valid || view.status === "invalid") return <InvalidLink />;
  if (view.status === "expired") return <Expired />;
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

  const join = (name: string) => room.join(name);

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
  // At most one note is edited at a time: the one with a draft. Phones edit it in a sheet.
  const editing = live && !wide ? view.board.notes.find((n) => n.draft !== null) : undefined;

  return (
    <>
      <PublishRoom code={code} view={view} room={room} />
      <Suspense fallback={<div className="absolute inset-0 bg-canvas" />}>
        <RoomBoard
          view={view}
          room={room}
          editing={editing !== undefined}
          onRejoin={() => room.rejoin()}
        />
      </Suspense>
      {editing && (
        <NoteEditor
          key="note-editor"
          entry={editing}
          author={authorName(editing.note.authorId, view)}
          onDraft={(text) => room.setDraft(editing.note.id, text)}
          onCommit={() => room.editNote(editing.note.id, editing.draft ?? editing.note.text)}
          onStyle={(change) => room.styleNote(editing.note.id, change)}
          onSize={(w, h) => room.setNoteSize(editing.note.id, w, h)}
          onDelete={() => room.deleteNote(editing.note.id)}
          onOrder={(action) => room.orderNotes([editing.note.id], action)}
        />
      )}
    </>
  );
}
