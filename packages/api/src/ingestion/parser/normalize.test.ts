import { describe, expect, it } from "vitest";

import { joinLinesWithDehyphenation, normalizeText } from "./normalize.js";

describe("normalizeText", () => {
  it("folds ligatures via NFKC", () => {
    expect(normalizeText("Konﬁdenzialität")).toBe("Konfidenzialität");
  });

  it("strips soft hyphens", () => {
    expect(normalizeText("K­ündigungs­frist")).toBe("Kündigungsfrist");
  });

  it("collapses exotic whitespace to single spaces", () => {
    expect(normalizeText("a b c\t d")).toBe("a b c d");
  });
});

describe("joinLinesWithDehyphenation", () => {
  it("merges words broken across lines when the continuation is lowercase", () => {
    expect(joinLinesWithDehyphenation(["Die Kündigungs-", "frist beträgt drei Monate."])).toBe(
      "Die Kündigungsfrist beträgt drei Monate.",
    );
  });

  it("keeps real hyphens before capitalized continuations", () => {
    expect(joinLinesWithDehyphenation(["Das VSOP-", "Programm der Gesellschaft"])).toBe(
      "Das VSOP- Programm der Gesellschaft",
    );
  });

  it("joins ordinary lines with spaces and skips empties", () => {
    expect(joinLinesWithDehyphenation(["Der Vertrag", "", "beginnt am 1. Januar."])).toBe(
      "Der Vertrag beginnt am 1. Januar.",
    );
  });
});
