import { MessageCircle, Send, X } from "lucide-react";
import { memo, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { MAX_TEXT_LENGTH } from "@stickyard/shared";
import { Button } from "../components/ui/button";
import { FieldError, Label } from "../components/ui/field";
import { Input } from "../components/ui/input";
import { Panel } from "../components/ui/panel";
import { cn } from "../lib/utils";
import { participantColourClass } from "../rooms/colours";
import { useRoomUi, useUnread, type PublishedRoom } from "../rooms/roomStore";
import { Sheet } from "../shell/Sheet";

/*
 * Chat (slice 1's message box, moved off the page). Messages go to everyone in the session
 * through the relay and aren't saved. Names and text are untrusted: rendered as text only.
 * The composer sits at the top and the newest message first, so a phone keyboard never
 * hides what you're typing.
 */

export function chatLabel(unread: number): string {
  return unread > 0 ? `Chat, ${unread} unread` : "Chat";
}

/** "Unread chat" dot. Decorative; the button's label says it in words. */
export function UnreadDot() {
  return (
    <span
      aria-hidden="true"
      data-testid="unread-dot"
      className="absolute top-ms right-ms size-badge rounded-full bg-accent ring-(length:--sy-badge-ring) ring-surface"
    />
  );
}

function Composer({ room }: { room: PublishedRoom }) {
  const id = useId();
  const [text, setText] = useState("");
  const [tooLong, setTooLong] = useState(false);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    if (room.say(text)) {
      setText("");
      setTooLong(false);
    } else setTooLong(room.live);
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-sm">
      <Label htmlFor={`${id}-message`}>Message</Label>
      <div className="flex gap-sm">
        <Input
          id={`${id}-message`}
          data-autofocus
          autoComplete="off"
          maxLength={MAX_TEXT_LENGTH * 2}
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={!room.live}
        />
        <Button type="submit" variant="primary" disabled={!room.live}>
          <Send />
          Send
        </Button>
      </div>
      {tooLong && <FieldError>Messages can be up to {MAX_TEXT_LENGTH} characters.</FieldError>}
    </form>
  );
}

function ChatBody({ room }: { room: PublishedRoom }) {
  const newestFirst = [...room.messages].reverse();
  return (
    <div className="flex flex-col gap-md pb-md">
      <p className="text-sm text-fg-muted">Everyone in the session sees these messages. They aren’t saved.</p>
      <Composer room={room} />
      {!room.live && <p className="text-sm text-fg-muted">Reconnect to send messages.</p>}
      {room.rateLimited && (
        <p role="status" className="text-sm text-status-warn">
          You’re sending messages quickly. Wait a moment, then try again.
        </p>
      )}
      <ol aria-label="Messages" className="flex flex-col gap-sm">
        {newestFirst.map((m) => (
          <li key={m.key} className="flex flex-col gap-2xs rounded-md border border-border bg-surface p-ms">
            <span className="flex items-center gap-sm text-sm font-medium">
              <span aria-hidden="true" className={cn("inline-block size-dot shrink-0 rounded-full", participantColourClass(m.colourIndex))} />
              <span className="min-w-0 break-words">{m.name}</span>
            </span>
            <span className="break-words whitespace-pre-wrap">{m.text}</span>
          </li>
        ))}
      </ol>
      {room.messages.length === 0 && <p className="text-sm text-fg-muted">No messages yet. Say hello.</p>}
    </div>
  );
}

/** Phones: chat is opened from the top bar or menu, as a bottom sheet. */
export function ChatSheet() {
  const room = useRoomUi((s) => s.room);
  const open = useRoomUi((s) => s.chatOpen);
  const close = useRoomUi((s) => s.closeChat);
  if (!room || !open) return null;
  return (
    <Sheet title="Chat" icon={<MessageCircle />} page="chat" onClose={close}>
      <ChatBody room={room} />
    </Sheet>
  );
}

/**
 * md and up: a floating chat button at the bottom right (above the minimap when it's shown),
 * opening a panel above it. Not modal: the board stays usable. Esc or X closes it.
 */
export const ChatDock = memo(function ChatDock({ aboveMinimap }: { aboveMinimap: boolean }) {
  const room = useRoomUi((s) => s.room);
  const open = useRoomUi((s) => s.chatOpen);
  const openChat = useRoomUi((s) => s.openChat);
  const close = useRoomUi((s) => s.closeChat);
  const unread = useUnread();
  const panelId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) panelRef.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
  }, [open]);

  if (!room) return null;
  const shut = () => {
    close();
    buttonRef.current?.focus();
  };

  return (
    <div
      data-chat-dock
      className={cn(
        "pointer-events-none absolute right-edge-r z-20 flex flex-col items-end gap-sm",
        aboveMinimap ? "bottom-chat-b" : "bottom-edge-b",
      )}
    >
      {open && (
        <Panel
          ref={panelRef}
          id={panelId}
          role="region"
          aria-label="Chat"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              shut();
            }
          }}
          className="sy-fade-in pointer-events-auto flex h-chat-h w-chat-w max-w-[calc(100vw-2*var(--sy-gutter))] flex-col shadow-lg"
        >
          <div className="flex min-h-touch shrink-0 items-center gap-xs border-b border-border pl-md">
            <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">Chat</h2>
            <Button variant="ghost" size="icon" aria-label="Close chat" title="Close chat (Esc)" onClick={shut}>
              <X />
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-md pt-md">
            <ChatBody room={room} />
          </div>
        </Panel>
      )}
      <Button
        ref={buttonRef}
        variant="secondary"
        size="icon"
        aria-label={chatLabel(unread)}
        title="Chat"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => (open ? shut() : openChat())}
        className="pointer-events-auto relative rounded-full shadow-lg"
      >
        <MessageCircle />
        {unread > 0 && <UnreadDot />}
      </Button>
    </div>
  );
});
