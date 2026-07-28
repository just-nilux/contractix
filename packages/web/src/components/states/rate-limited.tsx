import { type RateLimitError } from "../../api/errors.js";
import { formatDuration, useCountdown } from "../../lib/use-countdown.js";

/**
 * A 429 is never a full-page error here. The user did something reasonable and
 * hit a shared free-tier ceiling; the right answer is a banner on the control
 * they pressed, with a live countdown, leaving the rest of the page usable.
 */
export function RateLimitedNotice({ error, action }: { error: RateLimitError; action?: string }) {
  const remaining = useCountdown(error.retryAfterSeconds);

  return (
    <p
      role="status"
      className="rounded border border-severity-amber-border bg-severity-amber-surface px-3 py-2 text-sm text-severity-amber"
    >
      {error.limit !== null && error.windowSeconds !== null
        ? `${action ?? "That"} is limited to ${String(error.limit)} per ${formatDuration(error.windowSeconds)} on the anonymous demo. `
        : `${action ?? "That"} is rate limited on the anonymous demo. `}
      {remaining > 0 ? `Try again in ${formatDuration(remaining)}.` : "You can try again now."}
    </p>
  );
}
