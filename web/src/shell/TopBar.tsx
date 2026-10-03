import { Logo } from "../components/Logo";
import { Menu } from "./Menu";
import { ThemeToggle } from "./ThemeToggle";

/** Mark on the left; menu and theme toggle on the right. Same arrangement at every width. */
export function TopBar() {
  return (
    <header className="sy-safe-top sticky top-0 z-30 shrink-0 border-b border-border bg-surface">
      <div className="sy-safe-x flex h-header items-center justify-between gap-toolbar">
        <a href="#/" className="flex min-h-touch items-center rounded-md text-fg" aria-label="Stickyard, start page">
          <Logo />
        </a>
        <nav aria-label="App" className="flex items-center gap-toolbar">
          <Menu />
          <ThemeToggle />
        </nav>
      </div>
    </header>
  );
}
