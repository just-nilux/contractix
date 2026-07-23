import { describe, expect, it } from "vitest";

import {
  parseDateISO,
  parseDurationToMonths,
  parseMoney,
  parseNumber,
  parsePercent,
  valuesMatch,
} from "./normalize.js";

describe("parseNumber", () => {
  it("resolves DE and EN grouping", () => {
    expect(parseNumber("98.000")).toBe(98_000); // DE thousands
    expect(parseNumber("110,000")).toBe(110_000); // EN thousands
    expect(parseNumber("6,0")).toBe(6); // DE decimal
    expect(parseNumber("1.234,56")).toBe(1234.56);
    expect(parseNumber("0.85")).toBe(0.85);
    expect(parseNumber("1.5")).toBe(1.5);
  });

  it("applies Mio/k multipliers", () => {
    expect(parseNumber("6.0M")).toBe(6_000_000);
    expect(parseNumber("2 Mio")).toBe(2_000_000);
    expect(parseNumber("40k")).toBe(40_000);
  });
});

describe("parseMoney", () => {
  it("extracts amount and currency in either order", () => {
    expect(parseMoney("EUR 110,000")).toEqual({ amount: 110_000, currency: "EUR" });
    expect(parseMoney("98.000 EUR")).toEqual({ amount: 98_000, currency: "EUR" });
    expect(parseMoney("€6.0M")).toEqual({ amount: 6_000_000, currency: "EUR" });
    expect(parseMoney("40.000 EUR + VAT")).toEqual({ amount: 40_000, currency: "EUR" });
  });
});

describe("parseDurationToMonths", () => {
  it("normalizes years/months/weeks to months", () => {
    expect(parseDurationToMonths("12 Monate")).toBe(12);
    expect(parseDurationToMonths("6 months")).toBe(6);
    expect(parseDurationToMonths("4 years")).toBe(48);
    expect(parseDurationToMonths("48 months")).toBe(48);
    expect(parseDurationToMonths("2 weeks")).toBe(0); // rounds to nearest month
  });
});

describe("parsePercent", () => {
  it("reads percentages", () => {
    expect(parsePercent("30%")).toBe(30);
    expect(parsePercent("1,5 %")).toBe(1.5);
    expect(parsePercent("50")).toBe(50);
  });
});

describe("parseDateISO", () => {
  it("parses EN and DE date forms to ISO", () => {
    expect(parseDateISO("1 Oct 2026")).toBe("2026-10-01");
    expect(parseDateISO("1. Oktober 2026")).toBe("2026-10-01");
    expect(parseDateISO("15 Sep 2026")).toBe("2026-09-15");
    expect(parseDateISO("15.09.2026")).toBe("2026-09-15");
    expect(parseDateISO("2026-11-01")).toBe("2026-11-01");
  });
});

describe("valuesMatch", () => {
  it("compares scalars with normalization", () => {
    expect(valuesMatch(98_000, 98_000)).toBe(true);
    expect(valuesMatch("Unbefristet", "unbefristet ")).toBe(true);
    expect(valuesMatch(true, false)).toBe(false);
    expect(valuesMatch(null, null)).toBe(true);
    expect(valuesMatch(30, null)).toBe(false);
  });

  it("compares money objects and string arrays as multisets", () => {
    expect(
      valuesMatch({ amount: 98_000, currency: "EUR" }, { amount: 98_000, currency: "eur" }),
    ).toBe(true);
    expect(valuesMatch(["a", "b"], ["b", "a"])).toBe(true);
    expect(valuesMatch(["a", "b"], ["a", "c"])).toBe(false);
  });
});
