import { Lock } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { LOCK_TEXT, lockAnnouncement, lockedOut } from "./lock";

/*
 * The lock's notices at the top of the board. A guest on a locked board gets a calm, persistent
 * banner (no dismiss: it's true until the host unlocks). Changes are announced politely by one
 * region that's always there (locked, or unlocked, worded for a guest or the host). Plain text,
 * tokens only.
 */
export function LockNotices({ locked, isHost }: { locked: boolean; isHost: boolean }) {
  const [announcement, setAnnouncement] = useState("");
  const previous = useRef<boolean | null>(null);
  useEffect(() => {
    const text = lockAnnouncement(previous.current, locked, isHost);
    previous.current = locked;
    if (text) setAnnouncement(text);
  }, [locked, isHost]);
  return (
    <>
      <span data-lock-announcer="" role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </span>
      {lockedOut({ locked, isHost }) && (
        <p data-lock-banner="" className="pointer-events-auto flex items-center gap-sm rounded-md border border-border bg-surface px-ms py-xs text-sm text-fg shadow-md">
          <Lock aria-hidden="true" className="size-icon-sm shrink-0 text-fg-muted" />
          <span>{LOCK_TEXT.banner}</span>
        </p>
      )}
    </>
  );
}
