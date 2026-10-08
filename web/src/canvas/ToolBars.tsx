import { memo, useId, useState, type ReactNode, type Ref } from "react";
import { Button } from "../components/ui/button";
import { Panel } from "../components/ui/panel";
import { cn } from "../lib/utils";
import { toolsFor, type Surface, type Tool, type ToolContext } from "./tools";

/*
 * The board's tool surfaces, both built from the registry in tools.ts:
 *   md and up: the view bar, bottom centre of the free canvas area (zoom, fit, Select/Hand, map);
 *   phones:    one bottom ribbon (Select/Hand, Add note as the main round button, Fit), as
 *              Chalkline's phone toolbar; pinch zooms.
 * Adding things is the palette's job (palette panel from md up, add sheet on phones).
 * Labels are always the accessible name; the tooltip (title) only repeats them with the shortcut.
 */

function tooltip(tool: Tool, reason: string | null) {
  const base = tool.shortcut ? `${tool.label} (${tool.shortcut})` : tool.label;
  return reason ? `${base}: ${reason}` : base;
}

/**
 * A tool whose off state is explained (Tool.explain): aria-disabled (still focusable), the press does
 * nothing, and a tooltip above it (hover or keyboard focus; Escape hides it) gives the reason or the name.
 */
function ExplainedToolButton({ tool, ctx, reason }: { tool: Tool; ctx: ToolContext; reason: string | null }) {
  const tipId = useId();
  const [open, setOpen] = useState(false);
  const Icon = tool.icon;
  const off = reason !== null;
  return (
    <span className="relative inline-flex" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <Button
        variant="ghost"
        size="icon"
        data-tool={tool.id}
        aria-label={tool.label}
        aria-describedby={tipId}
        aria-keyshortcuts={tool.shortcut}
        aria-disabled={off || undefined}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && open) setOpen(false);
        }}
        onClick={(e) => {
          if (off) return void e.preventDefault();
          tool.run(ctx);
        }}
      >
        <Icon />
      </Button>
      <span
        role="tooltip"
        id={tipId}
        hidden={!open}
        data-tool-tip={tool.id}
        className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-xs -translate-x-1/2 rounded-md border border-border bg-surface px-sm py-xs text-xs font-normal whitespace-nowrap text-fg shadow-md"
      >
        {tooltip(tool, reason)}
      </span>
    </span>
  );
}

export function ToolButton({ tool, ctx, className }: { tool: Tool; ctx: ToolContext; className?: string }) {
  const reason = tool.disabled?.(ctx) ?? null;
  if (tool.explain) return <ExplainedToolButton tool={tool} ctx={ctx} reason={reason} />;
  const text = tool.text?.(ctx);
  const Icon = tool.icon;
  return (
    <Button
      variant={tool.primary ? "primary" : "ghost"}
      size={text ? "default" : "icon"}
      data-tool={tool.id}
      aria-label={tool.label}
      title={tooltip(tool, reason)}
      aria-pressed={tool.pressed ? tool.pressed(ctx) : undefined}
      disabled={reason !== null}
      onClick={() => tool.run(ctx)}
      className={cn(
        "aria-pressed:bg-accent-subtle aria-pressed:text-accent",
        text && "min-w-touch px-xs tabular-nums",
        tool.primary && "rounded-full shadow-md",
        className,
      )}
    >
      {text ?? <Icon />}
    </Button>
  );
}

/** The tools on a surface, with neighbouring tools of one segment (Select/Hand) grouped. */
function items(surface: Surface, ctx: ToolContext): ReactNode[] {
  const out: ReactNode[] = [];
  const tools = toolsFor(surface);
  for (let i = 0; i < tools.length; ) {
    const tool = tools[i];
    if (!tool) break;
    const segment = tool.segment;
    if (!segment) {
      out.push(<ToolButton key={tool.id} tool={tool} ctx={ctx} />);
      i++;
      continue;
    }
    const group: Tool[] = [];
    while (tools[i]?.segment?.id === segment.id) group.push(tools[i++] as Tool);
    out.push(
      <div key={`segment-${segment.id}`} role="group" aria-label={segment.label} className="flex gap-2xs rounded-md bg-surface-muted">
        {group.map((t) => (
          <ToolButton key={t.id} tool={t} ctx={ctx} />
        ))}
      </div>,
    );
  }
  return out;
}

function Bar({ surface, ctx, label, barRef, wrapped = false }: { surface: Surface; ctx: ToolContext; label: string; barRef?: Ref<HTMLDivElement> | undefined; wrapped?: boolean | undefined }) {
  return (
    <Panel
      ref={barRef}
      role="toolbar"
      aria-label={label}
      aria-orientation="horizontal"
      data-wrapped={wrapped || undefined}
      // On a canvas narrower than the bar (768 with both panels open) it wraps onto a second row
      // rather than running under the panels (v0.24.0).
      className={cn("pointer-events-auto flex max-w-full flex-wrap items-center justify-center gap-toolbar p-xs shadow-lg", wrapped ? "rounded-lg" : "rounded-full")}
    >
      {items(surface, ctx)}
    </Panel>
  );
}

/** md and up: the view bar, bottom centre of the free canvas area (two rows when the area is narrow). */
export const ViewBar = memo(function ViewBar({ ctx, barRef, wrapped }: { ctx: ToolContext; barRef?: Ref<HTMLDivElement> | undefined; wrapped?: boolean | undefined }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-edge-b z-20 flex justify-center px-gutter">
      <Bar surface="viewbar" ctx={ctx} label="View" barRef={barRef} wrapped={wrapped} />
    </div>
  );
});

/** Phones: one ribbon, bottom centre, above the safe area. */
export const Ribbon = memo(function Ribbon({ ctx }: { ctx: ToolContext }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-edge-b z-20 flex justify-center">
      <Bar surface="ribbon" ctx={ctx} label="Board tools" />
    </div>
  );
});
