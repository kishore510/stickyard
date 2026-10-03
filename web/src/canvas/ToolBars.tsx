import { memo, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { NOTE_COLORS, type NoteColor } from "@stickyard/shared";
import { Button } from "../components/ui/button";
import { Panel } from "../components/ui/panel";
import { cn } from "../lib/utils";
import { NOTE_COLOR_CLASSES, NOTE_COLOR_NAMES } from "../notes/colours";
import { toolsFor, type Surface, type Tool, type ToolContext } from "./tools";
import { useBoardUi } from "./uiStore";

/*
 * The board's tool surfaces, all built from the registry in tools.ts:
 *   md and up: a left tool rail (Select, Hand, Note + colour) and a bottom-centre view bar;
 *   phones:    one bottom ribbon (colour, Add note, Fit, Hand), since pinch zooms.
 * Labels are always the accessible name; the tooltip (title) only repeats them with the shortcut.
 */

function tooltip(tool: Tool, reason: string | null) {
  const base = tool.shortcut ? `${tool.label} (${tool.shortcut})` : tool.label;
  return reason ? `${base}: ${reason}` : base;
}

export function ToolButton({ tool, ctx, className }: { tool: Tool; ctx: ToolContext; className?: string }) {
  const reason = tool.disabled?.(ctx) ?? null;
  const text = tool.text?.(ctx);
  const Icon = tool.icon;
  return (
    <Button
      variant="ghost"
      size={text ? "default" : "icon"}
      data-tool={tool.id}
      aria-label={tool.label}
      title={tooltip(tool, reason)}
      aria-pressed={tool.pressed ? tool.pressed(ctx) : undefined}
      disabled={reason !== null}
      onClick={() => tool.run(ctx)}
      className={cn("aria-pressed:bg-accent-subtle aria-pressed:text-accent", text && "min-w-touch px-xs tabular-nums", className)}
    >
      {text ?? <Icon />}
    </Button>
  );
}

/** The note colour: a swatch button that opens a small popover of the six palette colours. */
export function ColourPicker({ side, disabled }: { side: "right" | "top"; disabled: boolean }) {
  const color = useBoardUi((s) => s.color);
  const setColor = useBoardUi((s) => s.setColor);
  const [open, setOpen] = useState(false);
  const id = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    popRef.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
    const outside = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!popRef.current?.contains(target) && !buttonRef.current?.contains(target)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [open]);

  const choose = (key: NoteColor) => {
    setColor(key);
    setOpen(false);
    buttonRef.current?.focus();
  };

  return (
    <div className="relative">
      <Button
        ref={buttonRef}
        variant="ghost"
        size="icon"
        aria-label={`Note colour: ${NOTE_COLOR_NAMES[color]}`}
        title={`Note colour: ${NOTE_COLOR_NAMES[color]}`}
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        <span aria-hidden="true" className={cn("size-swatch rounded-full border border-border-strong", NOTE_COLOR_CLASSES[color])} />
      </Button>
      {open && (
        <Panel
          ref={popRef}
          id={id}
          role="radiogroup"
          aria-label="Note colour"
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            e.stopPropagation();
            setOpen(false);
            buttonRef.current?.focus();
          }}
          className={cn(
            "sy-fade-in absolute z-40 grid grid-cols-3 gap-2xs p-xs shadow-lg",
            side === "right" ? "top-0 left-full ml-sm" : "bottom-full left-0 mb-sm",
          )}
        >
          {NOTE_COLORS.map((key) => (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={key === color}
              aria-label={NOTE_COLOR_NAMES[key]}
              title={NOTE_COLOR_NAMES[key]}
              onClick={() => choose(key)}
              className="flex size-touch cursor-pointer items-center justify-center rounded-md hover:bg-surface-muted"
            >
              <span
                aria-hidden="true"
                className={cn(
                  "size-swatch rounded-full border border-border-strong",
                  NOTE_COLOR_CLASSES[key],
                  key === color && "ring-2 ring-accent ring-offset-2 ring-offset-surface",
                )}
              />
            </button>
          ))}
        </Panel>
      )}
    </div>
  );
}

function Bar({ surface, ctx, label, className }: { surface: Surface; ctx: ToolContext; label: string; className: string }) {
  const vertical = surface === "rail";
  const items: ReactNode[] = [];
  for (const tool of toolsFor(surface)) {
    const button = <ToolButton key={tool.id} tool={tool} ctx={ctx} />;
    if (!tool.colour) {
      items.push(button);
      continue;
    }
    const picker = <ColourPicker key={`${tool.id}-colour`} side={vertical ? "right" : "top"} disabled={ctx.noteReason !== null} />;
    // On the rail the colour sits under Note; on the ribbon it comes first, then Add note.
    items.push(...(vertical ? [button, picker] : [picker, button]));
  }
  return (
    <Panel
      role="toolbar"
      aria-label={label}
      aria-orientation={vertical ? "vertical" : "horizontal"}
      className={cn("pointer-events-auto flex gap-toolbar p-xs shadow-lg", vertical ? "flex-col" : "items-center", className)}
    >
      {items}
    </Panel>
  );
}

/** md and up: the slim tool rail on the left, vertically centred. */
export const ToolRail = memo(function ToolRail({ ctx }: { ctx: ToolContext }) {
  return (
    <div className="pointer-events-none absolute top-0 bottom-0 left-edge-l z-20 flex items-center">
      <Bar surface="rail" ctx={ctx} label="Tools" className="" />
    </div>
  );
});

/** md and up: the view bar, bottom centre. */
export const ViewBar = memo(function ViewBar({ ctx }: { ctx: ToolContext }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-edge-b z-20 flex justify-center">
      <Bar surface="viewbar" ctx={ctx} label="View" className="rounded-full" />
    </div>
  );
});

/** Phones: one ribbon, bottom centre, above the safe area. */
export const Ribbon = memo(function Ribbon({ ctx }: { ctx: ToolContext }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-edge-b z-20 flex justify-center">
      <Bar surface="ribbon" ctx={ctx} label="Board tools" className="rounded-full" />
    </div>
  );
});
