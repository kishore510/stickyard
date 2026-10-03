import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

// text-base (16px) stops iOS Safari zooming the page when the field is focused.
export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return (
    <textarea
      className={cn(
        "w-full min-w-0 resize-none rounded-md border border-border-strong bg-surface p-ms text-base text-fg",
        "transition-colors placeholder:text-fg-muted focus-visible:border-focus",
        className,
      )}
      {...props}
    />
  );
}
