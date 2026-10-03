import { MessageCircle, Users } from "lucide-react";
import { ChatSheet, UnreadDot, chatLabel } from "../chat/ChatDock";
import { Logo } from "../components/Logo";
import { Button } from "../components/ui/button";
import { useMediaQuery } from "../lib/useMediaQuery";
import { useRoomUi, useUnread } from "../rooms/roomStore";
import { MEDIA } from "../styles/breakpoints";
import { Menu } from "./Menu";
import { openSheet } from "./nav";
import { ThemeToggle } from "./ThemeToggle";

/** In a session: Participants (all widths) and, on phones, Chat (from md up it floats on the board). */
function SessionButtons() {
  const count = useRoomUi((s) => (s.room?.live ? s.room.participants.length : null));
  const inRoom = useRoomUi((s) => s.room !== null);
  const chatOpen = useRoomUi((s) => s.chatOpen);
  const openChat = useRoomUi((s) => s.openChat);
  const unread = useUnread();
  const wide = useMediaQuery(MEDIA.tablet);
  if (!inRoom) return null;
  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        aria-label={count === null ? "Participants" : `Participants (${count})`}
        title="Participants"
        aria-haspopup="dialog"
        onClick={() => openSheet({ kind: "participants" })}
        className="relative"
      >
        <Users />
        {count !== null && (
          <span aria-hidden="true" className="absolute right-2xs bottom-2xs rounded-full bg-surface-muted px-xs text-xs font-semibold tabular-nums">
            {count}
          </span>
        )}
      </Button>
      {!wide && (
        <>
          <Button
            variant="ghost"
            size="icon"
            aria-label={chatLabel(unread)}
            title="Chat"
            aria-haspopup="dialog"
            aria-expanded={chatOpen}
            onClick={openChat}
            className="relative"
          >
            <MessageCircle />
            {unread > 0 && <UnreadDot />}
          </Button>
          <ChatSheet />
        </>
      )}
    </>
  );
}

/** Mark on the left; session buttons, menu and theme toggle on the right. */
export function TopBar() {
  return (
    <header className="sy-safe-top sticky top-0 z-30 shrink-0 border-b border-border bg-surface">
      <div className="sy-safe-x flex h-header items-center justify-between gap-toolbar">
        <a href="#/" className="flex min-h-touch items-center rounded-md text-fg" aria-label="Stickyard, start page">
          <Logo />
        </a>
        <nav aria-label="App" className="flex items-center gap-toolbar">
          <SessionButtons />
          <Menu />
          <ThemeToggle />
        </nav>
      </div>
    </header>
  );
}
