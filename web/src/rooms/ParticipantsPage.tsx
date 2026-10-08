import { Check, Copy, Crosshair, Lock, LockOpen, LogOut, Power, RotateCcw, Square } from "lucide-react";
import { useState } from "react";
import { MAX_NAME_LENGTH, MAX_PARTICIPANTS } from "@stickyard/shared";
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import { participantColourClass } from "./colours";
import { roomLink } from "./link";
import { useRoomUi } from "./roomStore";
import { useMediaQuery } from "../lib/useMediaQuery";
import { MEDIA } from "../styles/breakpoints";
import { useTimerControls } from "../timer/controls";
import { TimerForm } from "../timer/TimerForm";
import { HostVotingControls } from "../voting/HostVoting";
import { LOCK_TEXT, confirmEndSession, lockToggle } from "../facilitation/lock";
import { useCursorPrefs } from "../cursors/prefs";
import { useCursors } from "../cursors/cursorStore";
import { useBoardUi } from "../canvas/uiStore";
import { JUMP_HINT } from "../canvas/navigation";
import { truncateName } from "../presence/avatars";
import { closeSheets } from "../shell/nav";

/*
 * The Participants sheet (#/participants): who's in the session now, the unverified-names
 * notice, the room link and Leave. Names are untrusted: rendered as text only.
 */

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
    <div className="flex flex-col gap-sm">
      <Button onClick={copy} className="self-start">
        {state === "copied" ? <Check /> : <Copy />}
        Copy link
      </Button>
      <p role="status" className="text-sm break-all text-fg-muted">
        {state === "copied" && "Link copied. Anyone with it can join."}
        {state === "failed" && `Couldn’t copy. The link is: ${link}`}
      </p>
    </div>
  );
}

/**
 * The host's Session section (phones; from md up these controls are in the palette, the board
 * bar and Properties). Today: the timer (Restart and Stop while one exists, and the same presets
 * and minutes field as the picker, inline, so no second sheet opens over this one), the lock
 * (pending until the relay answers), dot voting (voting/HostVoting.tsx) and End session (one confirm).
 */
function SessionSection() {
  const room = useRoomUi((s) => s.room);
  const controls = useTimerControls();
  if (!room) return null;
  const off = controls.reason !== null;
  const lock = lockToggle({ locked: room.locked, pending: room.lockPending, live: room.live });
  return (
    <section aria-labelledby="session-heading" className="flex flex-col gap-sm">
      <h3 id="session-heading" className="text-base font-semibold">
        Session
      </h3>
      <p className="text-sm text-fg-muted">You’re the host: only you see these.</p>
      <h4 className="text-sm font-semibold">Timer</h4>
      {room.timer && (
        <div className="flex flex-wrap gap-sm">
          <Button aria-disabled={off || undefined} onClick={() => !off && controls.restart()}>
            <RotateCcw />
            Restart timer
          </Button>
          <Button aria-disabled={off || undefined} onClick={() => !off && controls.stop()}>
            <Square />
            Stop timer
          </Button>
        </div>
      )}
      <TimerForm running={room.timer !== null} reason={controls.reason} onStart={(ms) => void controls.start(ms)} />
      <h4 className="text-sm font-semibold">Board</h4>
      <div className="flex flex-col gap-xs">
        <Button
          className="self-start"
          aria-disabled={lock.reason !== null || undefined}
          aria-describedby={lock.reason ? "session-lock-reason" : undefined}
          onClick={() => lock.reason === null && room.setLock(!room.locked)}
        >
          {room.locked ? <LockOpen /> : <Lock />}
          {lock.label}
        </Button>
        {room.locked && lock.reason === null && <p className="text-sm text-fg-muted">{LOCK_TEXT.locked}: only hosts can change the board.</p>}
        {lock.reason && (
          <p id="session-lock-reason" className="text-xs text-fg-muted">
            {lock.reason}
          </p>
        )}
      </div>
      <h4 className="text-sm font-semibold">Dot voting</h4>
      <HostVotingControls />
      <h4 className="text-sm font-semibold">End the session</h4>
      <div className="flex flex-col gap-xs">
        <Button
          className="self-start text-status-error"
          aria-disabled={room.endReason !== null || undefined}
          aria-describedby={room.endReason ? "session-end-reason" : undefined}
          onClick={() => {
            if (room.endReason !== null || !confirmEndSession()) return;
            room.endSession();
          }}
        >
          <Power />
          End session
        </Button>
        {room.endReason && (
          <p id="session-end-reason" className="text-xs text-fg-muted">
            {room.endReason}
          </p>
        )}
      </div>
    </section>
  );
}

/**
 * Go to (v0.24.0): pans the board to this person's last known pointer. Off, with the reason shown,
 * until a pointer from them has been seen (phones never send one). The position lives in memory
 * only (cursorStore lastSeen), whatever the Show switch says. The sheet closes so the board shows.
 */
function GoTo({ id, name }: { id: string; name: string }) {
  const known = useCursors((s) => s.lastSeen.has(id));
  const reasonId = `goto-reason-${id}`;
  return (
    <span className="flex shrink-0 flex-col items-end py-2xs">
      <Button
        variant="ghost"
        data-goto={id}
        aria-label={`Go to ${truncateName(name)}’s pointer`}
        aria-disabled={!known || undefined}
        aria-describedby={known ? undefined : reasonId}
        onClick={() => {
          if (!known) return;
          closeSheets();
          useBoardUi.getState().requestJump(id);
        }}
      >
        <Crosshair />
        Go to
      </Button>
      {!known && (
        <span id={reasonId} className="text-xs text-fg-muted">
          {JUMP_HINT}
        </span>
      )}
    </span>
  );
}

/** One switch: a native checkbox with role=switch, in a full touch-target row. */
function Switch({ label, hint, checked, onChange }: { label: string; hint: string; checked: boolean; onChange(on: boolean): void }) {
  return (
    <label className="flex min-h-touch cursor-pointer items-start gap-ms rounded-md border border-border bg-surface p-ms">
      <input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-2xs size-icon shrink-0 accent-accent" />
      <span className="flex flex-col">
        <span className="font-medium">{label}</span>
        <span className="text-sm text-fg-muted">{hint}</span>
      </span>
    </label>
  );
}

/** Live cursors (v0.19.0): show other people's pointers, share mine. Remembered in this browser. */
function CursorSection({ wide }: { wide: boolean }) {
  const { show, share, set } = useCursorPrefs();
  return (
    <section aria-labelledby="cursors-heading" className="flex flex-col gap-sm">
      <h3 id="cursors-heading" className="text-base font-semibold">
        Cursors
      </h3>
      <Switch label="Show other people’s cursors" hint="Their pointers and names on the board, live." checked={show} onChange={(on) => set("show", on)} />
      <Switch
        label="Share my cursor"
        hint={wide ? "Others see your pointer while it’s over the board. Never stored." : "Phones never share a pointer; this applies on a bigger screen with a mouse or pen."}
        checked={share}
        onChange={(on) => set("share", on)}
      />
    </section>
  );
}

export function ParticipantsPage() {
  const room = useRoomUi((s) => s.room);
  const wide = useMediaQuery(MEDIA.tablet);
  if (!room) return <p className="pb-md">You’re not in a session. Join one from the start page.</p>;
  const people = room.live ? room.participants : [];

  return (
    <div className="flex flex-col gap-lg pb-md">
      <section aria-labelledby="participants-heading" className="flex flex-col gap-sm">
        <h3 id="participants-heading" className="text-base font-semibold">
          In this session now ({people.length} of {MAX_PARTICIPANTS})
        </h3>
        {!room.live && <p className="text-sm text-fg-muted">Reconnect to see who’s here.</p>}
        <ul aria-label="People in this session" className="flex flex-col gap-xs">
          {people.map((p) => (
            <li key={p.id} className="flex min-h-touch items-center gap-sm rounded-md border border-border bg-surface px-ms">
              <span aria-hidden="true" className={cn("inline-block size-dot shrink-0 rounded-full", participantColourClass(p.colourIndex))} />
              <span data-person-name="" className="min-w-0 flex-1 break-words">
                {p.name}
                {p.id === room.you?.id && <span className="text-fg-muted"> (you)</span>}
              </span>
              {p.host && (
                <span data-host-badge="" className="shrink-0 rounded-full border border-border bg-surface-muted px-sm text-xs font-semibold">
                  Host
                </span>
              )}
              {p.id !== room.you?.id && <GoTo id={p.id} name={p.name} />}
            </li>
          ))}
        </ul>
        <p className="rounded-md bg-surface-muted p-ms text-sm">
          Names aren’t verified: anyone with the link can join, and anyone can type any name (up to {MAX_NAME_LENGTH}{" "}
          characters).
        </p>
      </section>

      <CursorSection wide={wide} />

      {room.isHost && !wide && <SessionSection />}

      <section aria-labelledby="invite-heading" className="flex flex-col gap-sm">
        <h3 id="invite-heading" className="text-base font-semibold">
          Invite
        </h3>
        <p className="text-sm text-fg-muted">Share the session’s link. Anyone with it can join.</p>
        <CopyLink code={room.code} />
      </section>

      <section aria-labelledby="leave-heading" className="flex flex-col gap-sm">
        <h3 id="leave-heading" className="text-base font-semibold">
          Leave
        </h3>
        <p className="text-sm text-fg-muted">Your notes stay on the board.</p>
        <Button
          className="self-start"
          onClick={() => {
            room.leave();
            window.location.hash = "#/";
          }}
        >
          <LogOut />
          Leave session
        </Button>
      </section>
    </div>
  );
}
