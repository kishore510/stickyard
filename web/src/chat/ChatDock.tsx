import { MessageCircle, MoveDiagonal2, Send, X } from "lucide-react";
import { memo, useEffect, useId, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent } from "react";
import { MAX_TEXT_LENGTH } from "@stickyard/shared";
import { Button } from "../components/ui/button";
import { FieldError, Label } from "../components/ui/field";
import { Input } from "../components/ui/input";
import { Panel } from "../components/ui/panel";
import { cn } from "../lib/utils";
import { participantColourClass } from "../rooms/colours";
import { useRoomUi, useUnread, type PublishedRoom } from "../rooms/roomStore";
import { Sheet } from "../shell/Sheet";
import { chatKeyResize, dragChatSize, type ChatSize } from "./chatSize";
import { useChatLayout } from "./chatStore";
import { chatTime } from "./time";

/*
 * Chat (slice 1's message box, moved off the page). Messages go to everyone in the session
 * through the relay and aren't saved. Names and text are untrusted: rendered as text only.
 * The composer sits at the top and the newest message first, so a phone keyboard never
 * hides what you're typing. Each message shows when it arrived here.
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
              <span className="min-w-0 flex-1 break-words">{m.name}</span>
              <MessageTime at={m.at} />
            </span>
            <span className="break-words whitespace-pre-wrap">{m.text}</span>
          </li>
        ))}
      </ol>
      {room.messages.length === 0 && <p className="text-sm text-fg-muted">No messages yet. Say hello.</p>}
    </div>
  );
}

function MessageTime({ at }: { at: number }) {
  const t = chatTime(at);
  return (
    <time dateTime={t.iso} title={t.full} className="shrink-0 text-xs font-normal text-fg-muted tabular-nums">
      {t.short}
    </time>
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

/** Where the chat button sits in the free canvas area's bottom-right corner. */
const DOCK_BOTTOM = {
  edge: "bottom-edge-b",
  minimap: "bottom-chat-b",
  bar: "bottom-above-bar",
  "bar-minimap": "bottom-chat-bar-b",
} as const;

/**
 * md and up: a floating chat button at the bottom right of the free canvas area (above the
 * minimap when it's shown, and above the view bar when the area is too narrow for both),
 * opening a panel above it. Not modal: the board stays usable. Esc or X closes it. The grip at
 * its top left resizes it (drag, or arrow keys; double-click resets), and the size is kept.
 */
export const ChatDock = memo(function ChatDock({ bottom }: { bottom: keyof typeof DOCK_BOTTOM }) {
  const room = useRoomUi((s) => s.room);
  const open = useRoomUi((s) => s.chatOpen);
  const openChat = useRoomUi((s) => s.openChat);
  const close = useRoomUi((s) => s.closeChat);
  const unread = useUnread();
  const panelId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const size = useChatLayout((s) => s.size);
  const drag = useRef<{ x: number; y: number; start: ChatSize } | null>(null);

  /** The space the panel can take: the dock, less the chat button and the gap above it. */
  const space = (): ChatSize => {
    const dock = panelRef.current?.parentElement;
    const panel = panelRef.current?.getBoundingClientRect();
    // The panel's bottom stays put (it sits on the button), so it can grow up to the dock's top.
    const height = dock && panel ? panel.bottom - dock.getBoundingClientRect().top : Number.POSITIVE_INFINITY;
    return { width: dock?.clientWidth || Number.POSITIVE_INFINITY, height: height || Number.POSITIVE_INFINITY };
  };
  const current = (): ChatSize => {
    const r = panelRef.current?.getBoundingClientRect();
    return { width: r?.width ?? 0, height: r?.height ?? 0 };
  };
  const grip = {
    onPointerDown: (e: ReactPointerEvent<HTMLButtonElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture?.(e.pointerId);
      drag.current = { x: e.clientX, y: e.clientY, start: current() };
    },
    onPointerMove: (e: ReactPointerEvent<HTMLButtonElement>) => {
      const d = drag.current;
      if (!d) return;
      useChatLayout.getState().preview(dragChatSize(d.start, { x: e.clientX - d.x, y: e.clientY - d.y }, space()));
    },
    onPointerUp: () => {
      if (!drag.current) return;
      drag.current = null;
      useChatLayout.getState().commit(useChatLayout.getState().size);
    },
  };

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
        "pointer-events-none absolute top-sm right-edge-r left-edge-l z-20 flex flex-col items-end justify-end gap-sm",
        DOCK_BOTTOM[bottom],
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
          style={size ? { width: size.width, height: size.height } : undefined}
          className={cn("sy-fade-in pointer-events-auto flex min-h-0 max-w-full flex-col shadow-lg", !size && "h-chat-h w-chat-w")}
        >
          <div className="flex min-h-touch shrink-0 items-center gap-xs border-b border-border">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Resize chat"
              title="Resize chat: drag, or use the arrow keys. Double-click to reset."
              className="cursor-nwse-resize touch-none text-fg-muted"
              {...grip}
              onPointerCancel={grip.onPointerUp}
              onDoubleClick={() => useChatLayout.getState().commit(null)}
              onKeyDown={(e) => {
                const next = chatKeyResize(current(), e.key, e.shiftKey, space());
                if (!next) return;
                e.preventDefault();
                useChatLayout.getState().commit(next);
              }}
            >
              <MoveDiagonal2 />
            </Button>
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
