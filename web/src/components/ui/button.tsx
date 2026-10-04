import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

/* shadcn/ui-style button: variants with cva, every size and colour from tokens. */
export const buttonVariants = cva(
  [
    "inline-flex shrink-0 cursor-pointer items-center justify-center gap-sm rounded-md text-sm font-medium whitespace-nowrap select-none",
    "transition-colors",
    "disabled:pointer-events-none disabled:opacity-50",
    // Off but still focusable (it explains itself in a tooltip): looks off, does nothing.
    "aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:hover:bg-transparent",
    "[&_svg]:pointer-events-none [&_svg]:size-icon [&_svg]:shrink-0",
  ],
  {
    variants: {
      variant: {
        primary: "bg-accent text-accent-fg shadow-sm hover:bg-accent-hover active:bg-accent-hover",
        secondary: "border border-border bg-surface text-fg shadow-sm hover:bg-surface-muted active:bg-surface-muted",
        ghost: "text-fg hover:bg-surface-muted active:bg-surface-muted",
      },
      size: {
        default: "h-touch px-md",
        icon: "size-touch",
      },
    },
    defaultVariants: { variant: "secondary", size: "default" },
  },
);

export type ButtonProps = ComponentProps<"button"> & VariantProps<typeof buttonVariants>;

export function Button({ className, variant, size, type = "button", ...props }: ButtonProps) {
  return <button type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
