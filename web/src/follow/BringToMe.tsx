import { useEffect, useId, useState } from "react";
import { Megaphone } from "lucide-react";
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import { useRoomUi } from "../rooms/roomStore";
import { sendBring } from "./actions";
import { useFollow } from "./followStore";
import { BRING_COOLDOWN_MS, BRING_TEXT, bringReason } from "./followUi";

/*
 * The host's Bring to me (v0.31.0): asks everyone else to come to the host's view. No confirm (it
 * never moves anyone: each person gets a banner with Go there). Off for BRING_COOLDOWN_MS after
 * each one ("Wait a few seconds.", so the page never sends inside the relay's budget) and while
 * not connected. Guests never get it. Works on a locked board and during a silent round.
 */

/** Bring to me's state for this page: whether it shows (host), why it's off, whether one was just sent, and the press. */
export function useBringToMe() {
  const room = useRoomUi((s) => s.room);
  const sentAt = useFollow((s) => s.bringSentAt);
  // Re-render once when the cooldown ends.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (sentAt === null) return;
    const left = sentAt + BRING_COOLDOWN_MS - Date.now();
    if (left <= 0) return;
    const timer = setTimeout(() => setTick((n) => n + 1), left);
    return () => clearTimeout(timer);
  }, [sentAt]);
  const live = room?.live ?? false;
  const now = Date.now();
  const reason = bringReason({ live, now, sentAt });
  return {
    host: room?.isHost ?? false,
    reason,
    /** Sent within the cooldown (the line under the button says so). */
    sent: live && sentAt !== null && now - sentAt < BRING_COOLDOWN_MS,
    run: () => {
      const r = useRoomUi.getState().room;
      if (r) sendBring(r);
    },
  };
}

/** The button with its description, what it did and why it's off, as text (phones, and the Session panel below xl). */
export function BringToMeControl({ className }: { className?: string }) {
  const id = useId();
  const bring = useBringToMe();
  if (!bring.host) return null;
  const off = bring.reason !== null;
  return (
    <div data-bring-control="" role="group" aria-label={BRING_TEXT.heading} className={cn("flex flex-col gap-xs", className)}>
      <p className="text-sm text-fg-muted">{BRING_TEXT.about}</p>
      <Button
        className="self-start"
        data-bring-to-me=""
        aria-disabled={off || undefined}
        aria-describedby={off ? `${id}-reason` : undefined}
        onClick={() => !off && bring.run()}
      >
        <Megaphone />
        {BRING_TEXT.button}
      </Button>
      {bring.sent && (
        <p data-bring-sent="" className="text-xs">
          {BRING_TEXT.sent}
        </p>
      )}
      {off && (
        <p id={`${id}-reason`} data-bring-reason="" className="text-xs text-fg-muted">
          {bring.reason}
        </p>
      )}
    </div>
  );
}
