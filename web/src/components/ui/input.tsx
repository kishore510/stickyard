import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

// text-base (16px) stops iOS Safari zooming the page when the input is focused.
export function Input({ className, ...props }: ComponentProps<"input">) {
  return (
    <input
      className={cn(
        "h-touch w-full min-w-0 rounded-md border border-border-strong bg-surface px-ms text-base text-fg",
        "transition-colors placeholder:text-fg-muted focus-visible:border-focus",
        className,
      )}
      {...props}
    />
  );
}
