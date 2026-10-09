import { useEffect } from "react";
import { CircleStop, Megaphone, ScanEye, X } from "lucide-react";
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import { truncateName } from "../presence/avatars";
import { useRoomUi } from "../rooms/roomStore";
import { inField } from "../canvas/deleteKey";
import type { View } from "./follow";
import { clearFollowNotice, dismissBrought, useFollow } from "./followStore";
import { BRING_TEXT, BROUGHT_BANNER_MS, FOLLOW_NOTICE_MS, FOLLOW_TEXT } from "./followUi";

/*
 * Follow and Bring to me in the board's notice stack (v0.31.0), after the lock banner and the
 * voting and silent strips, so they stack under them and never overlap: the chip ("Following Sam"
 * or "Waiting for Sam's view." with Stop), "N following you" (md and up: phones never send their
 * view), one plain notice ("Stopped following Sam.", "Sam left."...), and the Bring to me banner
 * (Go there, Dismiss). One always-present polite announcer says the start, the stop, the end and
 * a sent Bring to me, never a viewport; the banner's sentence is its own polite status, said once.
 * Names are untrusted: truncated, plain text. Nothing here moves the view or takes focus.
 */

const pill = "pointer-events-auto flex max-w-content items-center gap-sm rounded-md bg-surface text-sm shadow-md";

/** A participant's name, truncated, or null when they aren't here. */
function useName(id: string | null): string | null {
  return useRoomUi((s) => {
    const p = id === null ? undefined : s.room?.participants.find((x) => x.id === id);
    return p ? truncateName(p.name) : null;
  });
}

function Chip({ onStop }: { onStop: () => void }) {
  const following = useFollow((s) => s.following);
  const waiting = useFollow((s) => s.leader === null);
  const stored = useFollow((s) => s.leaderName);
  const live = useName(following);
  if (following === null) return null;
  const name = stored ?? live ?? FOLLOW_TEXT.someone;
  return (
    <div data-follow-chip="" className={cn(pill, "border border-accent py-2xs pr-2xs pl-ms")}>
      <ScanEye aria-hidden="true" className="size-icon-sm shrink-0 text-accent" />
      <p className="flex min-w-0 flex-1 flex-col">
        <span className="break-words">{waiting ? FOLLOW_TEXT.waiting(name) : FOLLOW_TEXT.following(name)}</span>
        {waiting && <span className="text-xs text-fg-muted">{FOLLOW_TEXT.waitingWhy}</span>}
      </p>
      <Button variant="ghost" data-follow-stop="" aria-label={FOLLOW_TEXT.stopLabel(name)} onClick={onStop}>
        <CircleStop />
        {FOLLOW_TEXT.stop}
      </Button>
    </div>
  );
}

function Followers({ wide }: { wide: boolean }) {
  const count = useFollow((s) => s.followers);
  if (!wide || count === 0) return null;
  return (
    <p data-followers="" className={cn(pill, "px-ms py-2xs text-fg-muted")}>
      {FOLLOW_TEXT.followers(count)}
    </p>
  );
}

function Notice() {
  const notice = useFollow((s) => s.notice);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => clearFollowNotice(notice), FOLLOW_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);
  if (!notice) return null;
  return (
    <p data-follow-notice="" className={cn(pill, "px-ms py-xs break-words")}>
      {notice.text}
    </p>
  );
}

/**
 * The Bring to me banner: who asked, Go there (moves to the view they sent, stopping my follow
 * first) and Dismiss. Escape dismisses it too (outside fields and sheets). A newer one replaces
 * it; it goes by itself after BROUGHT_BANNER_MS (the host can send again).
 */
function Banner({ onGo }: { onGo: (view: View) => void }) {
  const brought = useFollow((s) => (s.brought && s.brought.seq !== s.dismissed ? s.brought : null));
  const following = useFollow((s) => s.following !== null);
  const leaderName = useFollow((s) => s.leaderName);
  const followingName = useName(useFollow((s) => s.following));
  const name = useName(brought?.from ?? null) ?? BRING_TEXT.someone;
  const seq = brought?.seq ?? 0;
  useEffect(() => {
    if (seq === 0) return;
    const timer = setTimeout(() => {
      if (useFollow.getState().brought?.seq === seq) dismissBrought();
    }, BROUGHT_BANNER_MS);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || inField(e.target) || document.querySelector('[aria-modal="true"]')) return;
      dismissBrought();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("keydown", onKey);
    };
  }, [seq]);
  // Focus was on the banner's buttons: put it back on the board, never nowhere.
  const done = (e: { currentTarget: HTMLElement }) => {
    const inside = e.currentTarget.closest("[data-brought-banner]")?.contains(document.activeElement);
    dismissBrought();
    if (inside) document.querySelector<HTMLElement>("main")?.focus();
  };
  const text = brought ? BRING_TEXT.banner(name) : "";
  return (
    <div
      data-brought-banner={brought ? "" : undefined}
      className={cn(brought ? cn(pill, "flex-wrap border border-accent py-2xs pr-2xs pl-ms") : "sr-only")}
    >
      {brought && <Megaphone aria-hidden="true" className="size-icon-sm shrink-0 text-accent" />}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Always in the page, so the sentence is announced once when it appears. */}
        <p data-brought-text="" role="status" aria-live="polite" className="break-words">
          {text}
        </p>
        {brought && following && <span className="text-xs text-fg-muted">{BRING_TEXT.bannerFollowing(leaderName ?? followingName ?? FOLLOW_TEXT.someone)}</span>}
      </div>
      {brought && (
        <div className="flex shrink-0 items-center gap-2xs">
          <Button
            variant="primary"
            data-brought-go=""
            onClick={(e) => {
              const { x, y, zoom } = brought;
              done(e);
              onGo({ x, y, zoom });
            }}
          >
            {BRING_TEXT.goThere}
          </Button>
          <Button variant="ghost" size="icon" data-brought-dismiss="" aria-label={BRING_TEXT.dismiss} title={BRING_TEXT.dismiss} onClick={done}>
            <X />
          </Button>
        </div>
      )}
    </div>
  );
}

export function FollowNotices({ wide, onStop, onGo }: { wide: boolean; onStop: () => void; onGo: (view: View) => void }) {
  const announce = useFollow((s) => s.announce);
  return (
    <>
      <span data-follow-announcer="" role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {announce?.text ?? ""}
      </span>
      <Chip onStop={onStop} />
      <Followers wide={wide} />
      <Notice />
      <Banner onGo={onGo} />
    </>
  );
}
