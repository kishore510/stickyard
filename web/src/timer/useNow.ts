import { useEffect, useState } from "react";

/**
 * This device's clock, refreshed once a second while `active` and the page is visible, and at
 * once when it becomes visible again (a background tab's timers are throttled; the countdown is
 * worked out from timestamps, so it's right as soon as it refreshes). No ticking while hidden.
 */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    const start = () => {
      setNow(Date.now());
      clearInterval(timer);
      if (document.visibilityState !== "hidden") timer = setInterval(() => setNow(Date.now()), 1000);
    };
    start();
    document.addEventListener("visibilitychange", start);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", start);
    };
  }, [active]);
  return active ? now : Date.now();
}
