import { MessageCircle, Users } from "lucide-react";
import { ChatSheet, UnreadDot, chatLabel } from "../chat/ChatDock";
import { Logo } from "../components/Logo";
import { Button } from "../components/ui/button";
import { useMediaQuery } from "../lib/useMediaQuery";
import { useRoomUi, useUnread } from "../rooms/roomStore";
import { MEDIA } from "../styles/breakpoints";
import { AvatarStack } from "../presence/AvatarStack";
import { peopleLabel } from "../presence/avatars";
import { Menu } from "./Menu";
import { openSheet } from "./nav";
import { ThemeToggle } from "./ThemeToggle";
import { useTopBarSlot } from "./topBarSlot";
import { TimerChip } from "../timer/TimerChip";

/**
 * In a session: Participants (all widths; from md up an avatar stack, on phones a count) and, on
 * phones, Chat (from md up it floats on the board).
 */
function SessionButtons() {
  const participants = useRoomUi((s) => (s.room?.live ? s.room.participants : null));
  const youId = useRoomUi((s) => s.room?.you?.id ?? null);
  const count = participants?.length ?? null;
  const inRoom = useRoomUi((s) => s.room !== null);
  const chatOpen = useRoomUi((s) => s.chatOpen);
  const openChat = useRoomUi((s) => s.openChat);
  const unread = useUnread();
  const wide = useMediaQuery(MEDIA.tablet);
  if (!inRoom) return null;
  return (
    <>
      {wide && participants !== null && participants.length > 0 ? (
        <Button
          variant="ghost"
          aria-label={peopleLabel(count)}
          title="Participants"
          aria-haspopup="dialog"
          onClick={() => openSheet({ kind: "participants" })}
          className="px-xs"
        >
          <AvatarStack participants={participants} youId={youId} />
        </Button>
      ) : (
        <Button
          variant="ghost"
          size="icon"
          aria-label={peopleLabel(count)}
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
      )}
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

/**
 * Mark on the left; session buttons, menu and theme toggle on the right. In between, a slot a page
 * can fill with a portal (shell/topBarSlot.ts): a room's board actions, from md up.
 */
export function TopBar() {
  const setSlot = useTopBarSlot((s) => s.set);
  return (
    <header className="sy-safe-top sticky top-0 z-40 shrink-0 border-b border-border bg-surface">
      <div className="sy-safe-x flex h-header items-center justify-between gap-toolbar">
        <a href="#/" className="flex min-h-touch items-center rounded-md text-fg" aria-label="Stickyard, start page">
          <Logo />
        </a>
        <div ref={setSlot} data-topbar-slot="" className="flex min-w-0 flex-1 justify-center" />
        <nav aria-label="App" className="flex items-center gap-toolbar">
          <TimerChip />
          <SessionButtons />
          <Menu />
          <ThemeToggle />
        </nav>
      </div>
    </header>
  );
}
