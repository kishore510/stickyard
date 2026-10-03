import { Monitor, Moon, Sun } from "lucide-react";
import { Button } from "../components/ui/button";
import { useThemeStore, type ThemePreference } from "./theme";

const ICONS = { system: Monitor, light: Sun, dark: Moon } as const;
const LABELS: Record<ThemePreference, string> = {
  system: "Theme: follow system",
  light: "Theme: light",
  dark: "Theme: dark",
};

/** One button that cycles follow system -> light -> dark. Its label says the current choice. */
export function ThemeToggle() {
  const preference = useThemeStore((s) => s.preference);
  const cycle = useThemeStore((s) => s.cycle);
  const Icon = ICONS[preference];
  return (
    <Button variant="ghost" size="icon" onClick={cycle} aria-label={`${LABELS[preference]} (change)`} title={LABELS[preference]}>
      <Icon />
    </Button>
  );
}
