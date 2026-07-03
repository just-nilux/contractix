import { describe, expect, it } from "vitest";

import { detectClauseLanguage, detectDocumentLanguage } from "./language.js";

const DE =
  "Das Arbeitsverhältnis beginnt am ersten Januar. Die Probezeit beträgt sechs Monate. " +
  "Während der Probezeit kann das Arbeitsverhältnis mit einer Frist von zwei Wochen gekündigt werden. " +
  "Der Arbeitnehmer erhält eine monatliche Vergütung sowie dreißig Tage Urlaub im Kalenderjahr.";

const EN =
  "This term sheet summarizes the principal terms of the proposed Series A financing. " +
  "The liquidation preference shall be one times the original purchase price, non-participating. " +
  "The option pool will be created prior to closing and dilutes the founders accordingly.";

describe("detectDocumentLanguage", () => {
  it("detects german and english documents", () => {
    expect(detectDocumentLanguage(DE)).toBe("de");
    expect(detectDocumentLanguage(EN)).toBe("en");
  });

  it("flags documents with substantial parts in both languages as mixed", () => {
    expect(detectDocumentLanguage(`${DE}\n${EN}\n${DE}\n${EN}`)).toBe("mixed");
  });
});

describe("detectClauseLanguage", () => {
  it("re-detects per clause only for mixed documents", () => {
    expect(detectClauseLanguage(EN, "mixed")).toBe("en");
    expect(detectClauseLanguage(DE, "mixed")).toBe("de");
    expect(detectClauseLanguage(EN, "de")).toBe("de"); // non-mixed docs stay uniform
  });

  it("short clauses inherit the document side", () => {
    expect(detectClauseLanguage("§ 2 Probezeit", "mixed")).toBe("de");
    expect(detectClauseLanguage("Cliff", "en")).toBe("en");
  });
});
