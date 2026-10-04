import { cn } from "../lib/utils";

/** The Stickyard mark: a sticky note on top of another. Colours from tokens. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className={cn("size-logo shrink-0", className)}>
      <g strokeWidth="2" strokeLinejoin="round">
        <rect x="3.5" y="5" width="16" height="16" rx="2" transform="rotate(-8 11.5 13)" className="fill-surface stroke-fg" />
        <path d="M12 11h16.5v11l-5.5 5.5H12Z" className="fill-accent stroke-accent" />
        <path d="M28.5 22H23v5.5" fill="none" className="stroke-accent-fg" />
      </g>
    </svg>
  );
}

/**
 * Mark and wordmark. Below lg the wordmark is visually hidden (room for the buttons: on phones, as
 * in Chalkline; on tablets since v0.16.0, for the board bar, the timer and the avatars).
 */
export function Logo() {
  return (
    <span className="inline-flex items-center gap-sm">
      <LogoMark />
      <span className="sr-only text-lg font-semibold tracking-tight lg:not-sr-only">Stickyard</span>
    </span>
  );
}
