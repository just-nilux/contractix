import { describe, expect, it } from "vitest";

import { CHECKS } from "./checks.js";
import { loadRules, rulesetVersion, runBenchmark } from "./engine.js";

describe("rules engine integrity", () => {
  it("joins every rule's metadata 1:1 with a check", () => {
    const rules = loadRules();
    expect(rules.length).toBe(Object.keys(CHECKS).length);
    expect(rules.length).toBeGreaterThanOrEqual(30);
    for (const r of rules) {
      expect(typeof r.check).toBe("function");
      expect(r.appliesTo.length).toBeGreaterThan(0);
      expect(r.rationale.length).toBeGreaterThan(0);
    }
  });

  it("exposes a pinned ruleset version", () => {
    expect(rulesetVersion()).toBe("1");
  });

  it("scopes rules to the document type", () => {
    const tsRule = loadRules().find((r) => r.id === "TS-LIQPREF-GT1X");
    expect(tsRule?.appliesTo).toContain("term_sheet");
    expect(tsRule?.appliesTo).not.toContain("employment_offer");
    // An empty extraction fires nothing.
    expect(runBenchmark({}, { documentType: "employment_offer" })).toEqual([]);
  });
});
