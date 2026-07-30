import { useEffect, useState } from "react";

/**
 * Counts a rate-limit window down to zero. A static "try again in 42 minutes"
 * goes stale the moment it renders, and the user has nothing to do but wait, so
 * the number should move.
 *
 * Each tick recomputes from an absolute deadline captured when the effect ran,
 * rather than decrementing: `setInterval` is throttled in a backgrounded tab, so
 * a decrementing counter would come back reading minutes too high. The clock is
 * read inside the effect, which is where reading one is legal - during render it
 * would be an impure call that makes the value depend on when React happens to
 * re-render.
 */
export function useCountdown(seconds: number): number {
  const [remaining, setRemaining] = useState(seconds);

  useEffect(() => {
    if (seconds <= 0) return;
    const deadline = Date.now() + seconds * 1000;
    const id = setInterval(() => {
      setRemaining(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
    }, 1000);
    return () => {
      clearInterval(id);
    };
  }, [seconds]);

  return remaining;
}

/** "42s", "3m 05s", "1h 12m" - precise where precision is actionable. */
export function formatDuration(seconds: number): string {
  if (seconds <= 0) return "now";
  if (seconds < 60) return `${String(seconds)}s`;
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${String(m)}m ${String(s).padStart(2, "0")}s`;
  }
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return `${String(h)}h ${String(m)}m`;
}
