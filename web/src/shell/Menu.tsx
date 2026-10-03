import { CircleHelp, Info, Menu as MenuIcon, MessageCircle, Sparkles, Users, type LucideIcon } from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { useWhatsNew } from "../changelog/whatsNew";
import { Button } from "../components/ui/button";
import { Panel } from "../components/ui/panel";
import { chatLabel } from "../chat/ChatDock";
import { useRoomUi, useUnread } from "../rooms/roomStore";
import type { Sheet } from "../router";
import { openSheet } from "./nav";

interface MenuItem {
  label: string;
  icon: LucideIcon;
  /** A sheet to open, or an action. */
  sheet?: Sheet;
  action?: () => void;
}

/*
 * Menu groups, separated by dividers. Later slices add their own groups here (for example
 * export) when those features exist. No placeholders until then. The Session group is shown
 * only while you're in a session (see SESSION_GROUP).
 */
const SESSION_GROUP: MenuItem[] = [
  { label: "Participants", icon: Users, sheet: { kind: "participants" } },
  { label: "Chat", icon: MessageCircle, action: () => useRoomUi.getState().openChat() },
];

const GROUPS: MenuItem[][] = [
  [
    { label: "Help", icon: CircleHelp, sheet: { kind: "help" } },
    { label: "What’s new", icon: Sparkles, sheet: { kind: "changelog" } },
  ],
  [{ label: "About Stickyard", icon: Info, sheet: { kind: "about" } }],
];

/** "Unread release notes" dot. Decorative; the button's label says it in words. */
export function UnseenDot() {
  return (
    <span
      aria-hidden="true"
      data-testid="unseen-dot"
      className="absolute top-ms right-ms size-badge rounded-full bg-accent ring-(length:--sy-badge-ring) ring-surface"
    />
  );
}

/** The top bar menu: a popover of icon + label items. */
export function Menu() {
  const [open, setOpen] = useState(false);
  const unseen = useWhatsNew((s) => s.unseen);
  const inRoom = useRoomUi((s) => s.room !== null);
  const unread = useUnread();
  const groups = inRoom ? [SESSION_GROUP, ...GROUPS] : GROUPS;
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const items = () => Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);

  useEffect(() => {
    if (!open) return;
    items()[0]?.focus();
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!menuRef.current?.contains(target) && !buttonRef.current?.contains(target)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open]);

  const onMenuKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const list = items();
    const index = list.indexOf(document.activeElement as HTMLElement);
    const move = (to: number) => {
      e.preventDefault();
      list[(to + list.length) % list.length]?.focus();
    };
    switch (e.key) {
      case "ArrowDown":
        return move(index + 1);
      case "ArrowUp":
        return move(index - 1);
      case "Home":
        return move(0);
      case "End":
        return move(list.length - 1);
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
        buttonRef.current?.focus();
        return;
      case "Tab":
        setOpen(false);
        return;
    }
  };

  const choose = (item: MenuItem) => {
    setOpen(false);
    // Focus goes back to the menu button, so closing the sheet returns it there.
    buttonRef.current?.focus();
    if (item.sheet) openSheet(item.sheet);
    item.action?.();
  };

  const label = unseen ? "Menu (new: what’s changed)" : "Menu";

  return (
    <div className="relative">
      <Button
        ref={buttonRef}
        variant="ghost"
        size="icon"
        aria-label={label}
        title="Menu"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((v) => !v)}
        className="relative"
      >
        <MenuIcon />
        {unseen && <UnseenDot />}
      </Button>
      {open && (
        <Panel
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label="Menu"
          onKeyDown={onMenuKeyDown}
          className="sy-fade-in absolute top-full right-0 z-40 mt-xs flex max-h-(--sy-menu-max-h) w-menu max-w-[calc(100vw-2*var(--sy-gutter))] flex-col overflow-y-auto p-xs shadow-lg"
        >
          {groups.map((group, g) => (
            <div key={g} role="group" className="flex flex-col">
              {g > 0 && <div role="separator" className="my-xs h-px bg-border" />}
              {group.map((item) => (
                <Button
                  key={item.label}
                  role="menuitem"
                  tabIndex={-1}
                  variant="ghost"
                  className="justify-start"
                  onClick={() => choose(item)}
                >
                  <item.icon />
                  <span className="flex-1 text-left">{item.label === "Chat" ? chatLabel(unread) : item.label}</span>
                  {item.sheet?.kind === "changelog" && unseen && (
                    <span className="rounded-full bg-accent px-sm text-xs font-semibold text-accent-fg">New</span>
                  )}
                </Button>
              ))}
            </div>
          ))}
        </Panel>
      )}
    </div>
  );
}
