/**
 * Heading matchers for German/English legal numbering (PRD FR-1.3).
 * Ordered: specific keyword forms first, bare decimal outline last (it is the
 * greediest and needs the most guards).
 */

export interface HeadingMatch {
  kind: "paragraph_sign" | "article" | "ziffer" | "section" | "preamble" | "annex" | "decimal";
  /** path segment inside the current numbering scope, e.g. "§4", "3.2", "art-iv" */
  path: string;
  /** hierarchy depth inside the scope (1 = top) */
  depth: number;
  /** annexes open a fresh numbering scope */
  opensScope: boolean;
  /** display heading (trimmed lead of the block) */
  heading: string;
}

const MONTHS =
  /^(Januar|Februar|März|Maerz|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember|January|February|March|May|June|July|October|December)\b/i;

function headingLabel(text: string): string {
  // First sentence-ish lead, capped - inline-numbered clauses carry the whole
  // clause body in one block ("2.1 Liquidation Preference. In the event ...").
  const firstStop = text.search(/[.:]\s/u);
  const lead = firstStop > 4 ? text.slice(0, firstStop) : text;
  return lead.length > 90 ? `${lead.slice(0, 87)}...` : lead;
}

export function matchHeading(text: string): HeadingMatch | null {
  let m = /^§\s*(\d{1,3}[a-z]?)\b/u.exec(text);
  if (m?.[1]) {
    return {
      kind: "paragraph_sign",
      path: `§${m[1]}`,
      depth: 1,
      opensScope: false,
      heading: headingLabel(text),
    };
  }

  m = /^Arti(?:cle|kel)\s+(\d{1,3}|[IVXLCDM]{1,7})\b/iu.exec(text);
  if (m?.[1]) {
    return {
      kind: "article",
      path: `art-${m[1].toLowerCase()}`,
      depth: 1,
      opensScope: false,
      heading: headingLabel(text),
    };
  }

  m = /^Ziff(?:er|\.)\s*(\d{1,3}(?:\.\d{1,3})*)\b/iu.exec(text);
  if (m?.[1]) {
    return {
      kind: "ziffer",
      path: `ziffer-${m[1]}`,
      depth: m[1].split(".").length,
      opensScope: false,
      heading: headingLabel(text),
    };
  }

  m = /^Section\s+(\d{1,3}(?:\.\d{1,3})*)\b/iu.exec(text);
  if (m?.[1]) {
    return {
      kind: "section",
      path: `sec-${m[1]}`,
      depth: m[1].split(".").length,
      opensScope: false,
      heading: headingLabel(text),
    };
  }

  if (/^(Präambel|Praeambel|Preamble|Recitals|Vorbemerkung)\b/iu.test(text)) {
    return {
      kind: "preamble",
      path: "praeambel",
      depth: 1,
      opensScope: false,
      heading: headingLabel(text),
    };
  }

  m = /^(Anlage|Annex|Appendix|Exhibit|Schedule)\s*(\d{1,2}|[A-Z])?\b/u.exec(text);
  if (m?.[1]) {
    const id = (m[2] ?? "1").toLowerCase();
    return {
      kind: "annex",
      path: `anlage-${id}`,
      depth: 0,
      opensScope: true,
      heading: headingLabel(text),
    };
  }

  // Bare decimal outline: "3", "3.2", "10.1.4" - with guards against dates
  // ("1. Januar 2027 ...") and years ("2026. ...").
  m = /^(\d{1,2}(?:\.\d{1,3})*)[.)]?\s+(\S.*)/u.exec(text);
  if (m?.[1] && m[2] !== undefined) {
    const rest = m[2];
    if (MONTHS.test(rest)) return null;
    const segments = m[1].split(".");
    // A bare top-level number needs an explicit "1." / "1)" marker or a
    // capitalized title to count as a heading; "2.1" style is signal enough.
    const marked = /^\d{1,2}[.)]\s/u.test(text);
    const capitalizedTitle = /^[A-ZÄÖÜ]/u.test(rest);
    if (segments.length === 1 && !(marked && capitalizedTitle)) return null;
    return {
      kind: "decimal",
      path: m[1],
      depth: segments.length,
      opensScope: false,
      heading: headingLabel(text),
    };
  }

  return null;
}
