import { type Money } from "./field.js";

/** NFKC-fold, collapse whitespace, lowercase — the canonical form for string comparison. */
export function normalizeString(s: string): string {
  return s.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase();
}

/**
 * Parse a grouped number, resolving DE vs EN separators by position:
 * the separator nearest the end is the decimal; a `.`/`,` followed by exactly
 * three digits (and never by 1-2) is a thousands group. Handles `98.000` (DE),
 * `110,000` (EN), `6,0` (DE decimal), `1.234,56`, `0.85`, `1.5`.
 */
function parseGroupedNumber(str: string): number | null {
  let s = str.trim();
  const hasDot = s.includes(".");
  const hasComma = s.includes(",");
  if (hasDot && hasComma) {
    if (s.lastIndexOf(",") > s.lastIndexOf(".")) {
      s = s.replace(/\./gu, "").replace(",", ".");
    } else {
      s = s.replace(/,/gu, "");
    }
  } else if (hasComma) {
    if (/,\d{3}(?:\D|$)/u.test(s) && !/,\d{1,2}(?:\D|$)/u.test(s)) {
      s = s.replace(/,/gu, "");
    } else {
      s = s.replace(",", ".");
    }
  } else if (hasDot && /\.\d{3}(?:\D|$)/u.test(s) && !/\.\d{1,2}(?:\D|$)/u.test(s)) {
    s = s.replace(/\./gu, "");
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Parse a number with optional Mio/k multiplier: `6.0M` → 6000000, `98.000` → 98000. */
export function parseNumber(raw: string): number | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase();
  const m = /(-?\d[\d.,]*)\s*(mio\.?|mln|millionen?|million|m|k|tsd\.?|tausend)?/u.exec(s);
  if (!m?.[1]) return null;
  const base = parseGroupedNumber(m[1]);
  if (base === null) return null;
  const suffix = m[2] ?? "";
  let mult = 1;
  if (/^(m|mio|mln|million)/u.test(suffix)) mult = 1_000_000;
  else if (/^(k|tsd|tausend)/u.test(suffix)) mult = 1_000;
  return base * mult;
}

const CURRENCY_SYMBOLS: Record<string, string> = { "€": "EUR", $: "USD", "£": "GBP" };

/** Parse `€6.0M`, `EUR 110,000`, `98.000 EUR` → { amount, currency }. */
export function parseMoney(raw: string): Money | null {
  if (typeof raw !== "string") return null;
  const amount = parseNumber(raw);
  if (amount === null) return null;
  let currency = "";
  for (const [sym, code] of Object.entries(CURRENCY_SYMBOLS)) {
    if (raw.includes(sym)) {
      currency = code;
      break;
    }
  }
  if (!currency) {
    const code = /\b(eur|usd|gbp|chf)\b/iu.exec(raw);
    if (code?.[1]) currency = code[1].toUpperCase();
  }
  return { amount, currency };
}

/** Normalize any duration to whole months: `4 years` → 48, `12 Monate` → 12, `2 weeks` → ~1. */
export function parseDurationToMonths(raw: string): number | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase();
  const m =
    /(\d+(?:[.,]\d+)?)\s*(jahren|jahre|jahr|years|year|yrs|yr|monaten|monate|monat|months|month|mos|woche[n]?|weeks|week|wo|w|y|m)\b/u.exec(
      s,
    );
  if (!m?.[1]) return parseNumber(s);
  const n = parseGroupedNumber(m[1]);
  if (n === null) return null;
  const unit = m[2] ?? "";
  if (/^(jahr|year|yr|y)/u.test(unit)) return n * 12;
  if (/^(woche|week|wo|w)/u.test(unit)) return Math.round((n * 12) / 52);
  return n;
}

/** Extract a percentage: `30%` → 30, `1,5 %` → 1.5. */
export function parsePercent(raw: string): number | null {
  if (typeof raw !== "string") return null;
  const m = /(-?\d+(?:[.,]\d+)?)\s*%/u.exec(raw);
  if (m?.[1]) return parseGroupedNumber(m[1]);
  return parseNumber(raw);
}

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  mär: 3,
  apr: 4,
  may: 5,
  mai: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  okt: 10,
  nov: 11,
  dec: 12,
  dez: 12,
};

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Parse a date to ISO `YYYY-MM-DD`: `1 Oct 2026`, `1. Oktober 2026`, `15.09.2026`. */
export function parseDateISO(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase();

  const iso = /(\d{4})-(\d{2})-(\d{2})/u.exec(s);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const named = /(\d{1,2})\.?\s+([a-zä]+)\.?\s+(\d{4})/u.exec(s);
  if (named?.[1] && named[2] && named[3]) {
    const day = Number(named[1]);
    const mon = MONTHS[named[2].slice(0, 3)];
    const year = Number(named[3]);
    if (mon && day >= 1 && day <= 31) return `${year}-${pad(mon)}-${pad(day)}`;
  }

  const dmy = /(\d{1,2})\.(\d{1,2})\.(\d{4})/u.exec(s);
  if (dmy?.[1] && dmy[2] && dmy[3]) {
    return `${dmy[3]}-${pad(Number(dmy[2]))}-${pad(Number(dmy[1]))}`;
  }
  return null;
}

function numbersClose(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-6 + 1e-4 * Math.max(Math.abs(a), Math.abs(b));
}

function arraysMatch(expected: unknown[], actual: unknown[]): boolean {
  if (expected.length !== actual.length) return false;
  const remaining = [...actual];
  for (const e of expected) {
    const idx = remaining.findIndex((a) => valuesMatch(e, a));
    if (idx === -1) return false;
    remaining.splice(idx, 1);
  }
  return true;
}

function objectsMatch(expected: Record<string, unknown>, actual: Record<string, unknown>): boolean {
  const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  for (const k of keys) {
    if (!valuesMatch(expected[k], actual[k])) return false;
  }
  return true;
}

/**
 * Structural equality with normalization: numbers within tolerance, strings
 * NFKC/case/whitespace-folded, arrays as multisets, objects key-by-key. Used
 * both to compare an extracted value against eval gold and to dedupe values.
 */
export function valuesMatch(expected: unknown, actual: unknown): boolean {
  if (expected === null || expected === undefined) return actual === null || actual === undefined;
  if (actual === null || actual === undefined) return false;
  if (typeof expected === "number" && typeof actual === "number")
    return numbersClose(expected, actual);
  if (typeof expected === "boolean" || typeof actual === "boolean") return expected === actual;
  if (typeof expected === "string" && typeof actual === "string") {
    return normalizeString(expected) === normalizeString(actual);
  }
  if (Array.isArray(expected) && Array.isArray(actual)) return arraysMatch(expected, actual);
  if (typeof expected === "object" && typeof actual === "object") {
    return objectsMatch(expected as Record<string, unknown>, actual as Record<string, unknown>);
  }
  return false;
}
