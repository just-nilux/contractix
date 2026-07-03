import { describe, expect, it } from "vitest";

import { matchHeading } from "./patterns.js";

describe("matchHeading", () => {
  it.each([
    ["§ 4 Vergütung", "paragraph_sign", "§4", 1],
    ["§4a Sondervergütung", "paragraph_sign", "§4a", 1],
    ["Artikel 7 Wettbewerbsverbot", "article", "art-7", 1],
    ["Article IV Liquidation Preference", "article", "art-iv", 1],
    ["Ziffer 5 Verschwiegenheit", "ziffer", "ziffer-5", 1],
    ["Ziff. 5.2 Nebentätigkeit", "ziffer", "ziffer-5.2", 2],
    ["Section 2.1 Anti-Dilution Protection", "section", "sec-2.1", 2],
    ["Präambel", "preamble", "praeambel", 1],
    ["Preamble", "preamble", "praeambel", 1],
    ["Anlage 1 Vestingregelungen", "annex", "anlage-1", 0],
    ["Annex B Option Terms", "annex", "anlage-b", 0],
    ["3.2 Cliff und Vesting", "decimal", "3.2", 2],
    ["10.1.4 Verfall", "decimal", "10.1.4", 3],
    ["2. Vergütung", "decimal", "2", 1],
    ["7) Urlaub", "decimal", "7", 1],
  ] as const)("%s -> %s %s depth %i", (text, kind, path, depth) => {
    const m = matchHeading(text);
    expect(m).not.toBeNull();
    expect(m?.kind).toBe(kind);
    expect(m?.path).toBe(path);
    expect(m?.depth).toBe(depth);
  });

  it("captures inline-numbered clause leads as heading labels", () => {
    const m = matchHeading(
      "2.1 Liquidation Preference. In the event of any liquidation the holders of Series A shall be entitled to receive the greater of...",
    );
    expect(m?.path).toBe("2.1");
    expect(m?.heading).toBe("2.1 Liquidation Preference");
  });

  it.each([
    "1. Januar 2027 beginnt das Arbeitsverhältnis", // date, not a clause
    "12. March 2027 the agreement commences",
    "2026 war ein gutes Jahr", // bare year, no marker
    "Der Vertrag beginnt am 1. Januar.",
    "(a) erste Unterklausel", // lettered sub-items never open clauses
    "(i) zweite Unterklausel",
    "im übrigen gilt § 613a BGB", // statute citation mid-sentence, not at start
  ])("rejects %s", (text) => {
    expect(matchHeading(text)).toBeNull();
  });
});
