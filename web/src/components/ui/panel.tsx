import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

/** Raised surface for popovers, cards and floating bars. */
export function Panel({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("rounded-lg border border-border bg-surface text-fg shadow-md", className)} {...props} />;
}
