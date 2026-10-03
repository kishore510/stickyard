import type { ReactNode } from "react";
import { APP_VERSION } from "../version";
import { openSheet } from "./nav";
import { TopBar } from "./TopBar";

/** Skip link: focuses <main> directly, since a `#main` href would change the hash route. */
function SkipLink() {
  return (
    <a
      href="#/"
      onClick={(e) => {
        e.preventDefault();
        document.getElementById("main")?.focus();
      }}
      className="sr-only z-50 rounded-md bg-surface px-md py-sm font-medium text-accent shadow-md focus:not-sr-only focus:fixed focus:top-sm focus:left-sm focus:inline-flex focus:min-h-touch focus:items-center"
    >
      Skip to content
    </a>
  );
}

/**
 * The app shell: skip link, top bar (header + nav), page content (main) and footer.
 * The floating bottom bar region (Chalkline's thumb toolbar) is left for slice 2's add note.
 */
export function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-(--sy-viewport-h) flex-col">
      <SkipLink />
      <TopBar />
      <main id="main" tabIndex={-1} className="sy-safe-x flex flex-1 flex-col outline-none">
        {children}
      </main>
      <footer className="sy-safe-x sy-safe-bottom flex justify-center pt-sm">
        <a
          href="#/about"
          onClick={(e) => {
            e.preventDefault();
            openSheet({ kind: "about" });
          }}
          aria-haspopup="dialog"
          className="inline-flex min-h-touch items-center rounded-md px-sm text-xs text-fg-muted hover:text-fg"
        >
          Stickyard v{APP_VERSION}
        </a>
      </footer>
    </div>
  );
}
