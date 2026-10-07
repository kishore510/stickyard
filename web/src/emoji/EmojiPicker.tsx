import { useEffect, useId, useRef, useState, type FocusEvent, type KeyboardEvent, type SyntheticEvent } from "react";
import { createPortal } from "react-dom";
import { Smile } from "lucide-react";
import { Button, buttonVariants } from "../components/ui/button";
import { cn } from "../lib/utils";
import { EMOJI, EMOJI_FULL, emojiKeyMove, insertEmoji, laidOutColumns } from "./emoji";

/** A text field the picker types into. */
export type EmojiField = HTMLTextAreaElement | HTMLInputElement;

/** Marks the picker (button and panel), so text edited in place doesn't end when focus moves into it. */
export const EMOJI_ROOT = "[data-emoji-root]";

/** Whether focus moving to `to` is moving into an emoji picker. */
export const intoEmojiPicker = (to: EventTarget | null) => to instanceof Element && to.closest(EMOJI_ROOT) !== null;

/** Keeps the picker's events from reaching the note or shape around it (React Flow's node handlers). */
const contain = (e: SyntheticEvent) => e.stopPropagation();

/**
 * A small built-in emoji picker (v0.21.0, no library): a labelled button that opens a grid of
 * EMOJI, 44px each. Choosing one inserts it at the field's caret (replacing a selection), puts
 * focus and the caret back in the field and closes; one that would pass the field's cap
 * (`fits`) inserts nothing and the panel says so. Arrow keys, Home and End move between emoji
 * (one tab stop), Enter or Space choose, Escape closes back to the field; a press outside closes.
 * `float`: beside text edited on the board (the panel floats over the canvas and keeps its
 * events to itself); otherwise the panel opens in the form's flow, in `slot` when given (below
 * the field, the button sitting on the label's row). `onAway` hears focus leaving
 * the picker for somewhere other than the field (text edited in place commits then).
 */
export function EmojiPicker({
  label,
  target,
  fits,
  onInsert,
  disabled = false,
  float = false,
  onAway,
  slot,
}: {
  label: string;
  /** The field to insert into (read when an emoji is chosen). */
  target: () => EmojiField | null;
  fits: (next: string) => boolean;
  onInsert: (value: string, caret: number) => void;
  disabled?: boolean;
  float?: boolean;
  onAway?: (to: Element | null) => void;
  /** Where the panel opens in a form (not floating). */
  slot?: HTMLElement | null;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [full, setFull] = useState(false);
  const panelId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const inside = (node: Node) => rootRef.current?.contains(node) === true || panelRef.current?.contains(node) === true;
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    if (open) buttons.current[active]?.focus();
  }, [open, active]);

  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      if (e.target instanceof Node && inside(e.target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", down, true);
    return () => document.removeEventListener("pointerdown", down, true);
  }, [open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  // Focus goes back to the field before the panel goes, so the field never sees focus lost.
  const close = () => {
    target()?.focus();
    setOpen(false);
  };

  const choose = (index: number, char: string) => {
    const el = target();
    if (!el) return;
    const at = el.selectionStart ?? el.value.length;
    const out = insertEmoji(el.value, at, el.selectionEnd ?? at, char, fits);
    setActive(index);
    if (!out) {
      setFull(true);
      return;
    }
    onInsert(out.value, out.caret);
    close();
    // After the field shows its new value (setting a value moves the caret to the end).
    setTimeout(() => target()?.setSelectionRange(out.caret, out.caret), 0);
  };

  const keyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    const columns = laidOutColumns(buttons.current.map((b) => b?.offsetTop ?? 0));
    const next = emojiKeyMove(active, e.key, EMOJI.length, columns);
    if (next === null) return;
    e.preventDefault();
    e.stopPropagation();
    setActive(next);
    buttons.current[next]?.focus();
  };

  const blur = (e: FocusEvent<HTMLDivElement>) => {
    if (float) e.stopPropagation();
    const to = e.relatedTarget instanceof Element ? e.relatedTarget : null;
    if (to && (inside(to) || to === target())) return;
    setOpen(false);
    onAway?.(to);
  };

  const floatGuards = float
    ? {
        onPointerDown: contain,
        onMouseDown: contain,
        onClick: contain,
        onDoubleClick: contain,
        onKeyDown: contain,
        onFocus: contain,
        onContextMenu: contain,
      }
    : {};

  const panel = (
    <div
      ref={panelRef}
      id={panelId}
      data-emoji-root=""
      data-emoji-picker=""
      role="group"
      aria-label="Emoji"
      onKeyDown={keyDown}
      className={cn(
        "flex flex-wrap gap-xs rounded-md border border-border bg-surface p-xs",
        float ? "absolute top-full left-0 z-10 mt-xs w-max max-w-emoji shadow-lg" : "mt-xs",
      )}
    >
      {EMOJI.map((e, i) => (
        <button
          key={e.char}
          ref={(el) => {
            buttons.current[i] = el;
          }}
          type="button"
          data-emoji=""
          aria-label={e.name}
          title={e.name}
          tabIndex={i === active ? 0 : -1}
          onClick={() => choose(i, e.char)}
          className={cn(buttonVariants({ variant: "ghost", size: "icon" }), "text-xl")}
        >
          {e.char}
        </button>
      ))}
      {full && (
        <p data-emoji-full="" role="status" className="w-full text-sm text-fg-muted">
          {EMOJI_FULL}
        </p>
      )}
    </div>
  );

  return (
    <div ref={rootRef} data-emoji-root="" className={cn("relative", float && "nodrag nopan nowheel")} {...floatGuards} onBlur={blur}>
      <Button
        variant="ghost"
        size="icon"
        data-emoji-trigger=""
        aria-label={label}
        title={label}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        disabled={disabled}
        onClick={() => {
          if (open) return setOpen(false);
          setActive(0);
          setFull(false);
          setOpen(true);
        }}
      >
        <Smile aria-hidden="true" />
      </Button>
      {open && (slot && !float ? createPortal(panel, slot) : panel)}
    </div>
  );
}
