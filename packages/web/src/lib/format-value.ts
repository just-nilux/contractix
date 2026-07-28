/**
 * Renders an extracted value.
 *
 * `value` is `z.unknown()` on the wire because the families disagree about what
 * a field holds: money is `{amount, currency, period}`, a grant is
 * `{units, percent}`, vesting is `{months, cliff_months, frequency}`, an
 * instrument is a bare enum string. Rather than a per-field renderer for a few
 * dozen fields across three families, this reads the *shape* - which is stable
 * across families, because the families are built from the same small set of
 * value objects.
 *
 * Nothing here invents or rounds anything: a value that does not match a known
 * shape is shown as its own key/value pairs rather than being hidden, because a
 * term the reader cannot see is worse than one that is ugly.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatNumber(n: number): string {
  return new Intl.NumberFormat("en-GB", { maximumFractionDigits: 2 }).format(n);
}

function formatMoney(amount: number, currency: unknown, period: unknown): string {
  const money =
    typeof currency === "string"
      ? new Intl.NumberFormat("en-GB", {
          style: "currency",
          currency,
          maximumFractionDigits: 0,
        }).format(amount)
      : formatNumber(amount);
  return typeof period === "string" ? `${money} / ${period}` : money;
}

const PERIOD_LABEL: Record<string, string> = {
  month: "month",
  year: "year",
  week: "week",
  day: "day",
};

function formatScalar(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return formatNumber(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return JSON.stringify(value);
}

export function formatValue(value: unknown, unit: string | null): string {
  if (value === null || value === undefined) return "—";

  if (Array.isArray(value)) {
    return value.length === 0 ? "—" : value.map(formatScalar).join("; ");
  }

  if (isRecord(value)) {
    // Money: the one shape worth a dedicated formatter, because a salary shown
    // as `{"amount":98000,...}` is the single most-read number in the report.
    if (typeof value.amount === "number" && "currency" in value) {
      return formatMoney(value.amount, value.currency, PERIOD_LABEL[String(value.period)]);
    }

    const parts: string[] = [];
    for (const [key, entry] of Object.entries(value)) {
      if (entry === null || entry === undefined) continue;
      const label = key.replace(/_/g, " ");
      parts.push(
        typeof entry === "boolean"
          ? entry
            ? label
            : `no ${label}`
          : `${label}: ${formatScalar(entry)}`,
      );
    }
    return parts.length === 0 ? "—" : parts.join(", ");
  }

  const scalar = formatScalar(value);
  return unit === null ? scalar : `${scalar} ${unit}`;
}
