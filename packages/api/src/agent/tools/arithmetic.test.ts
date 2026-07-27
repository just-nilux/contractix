import { describe, expect, it } from "vitest";

import { evaluateArithmetic } from "./arithmetic.js";

const value = (expr: string): number | undefined => evaluateArithmetic(expr).value;

describe("evaluateArithmetic", () => {
  it("respects precedence and associativity", () => {
    expect(value("2 + 3 * 4")).toBe(14);
    expect(value("(2 + 3) * 4")).toBe(20);
    expect(value("100 - 20 - 5")).toBe(75); // left-associative
    expect(value("2 ^ 3 ^ 2")).toBe(512); // right-associative
    expect(value("-2 ^ 2")).toBe(-4); // unary binds looser than ^
    expect(value("10 / 4")).toBe(2.5);
  });

  it("handles the cap-table arithmetic the tool exists for", () => {
    // Post-money ownership after a round.
    expect(value("1000000 / (1000000 + 250000) * 100")).toBeCloseTo(80, 10);
    // Founder dilution from a 10% pre-money ESOP pool.
    expect(value("(1 - 0.10) * 100")).toBeCloseTo(90, 10);
    // 4-year vest, 1-year cliff: months vested at 18 months.
    expect(value("18 / 48 * 100")).toBeCloseTo(37.5, 10);
  });

  it("parses decimals, exponents and nested unary signs", () => {
    expect(value("1.5e3")).toBe(1500);
    expect(value(".5 + .25")).toBe(0.75);
    expect(value("--3")).toBe(3);
    expect(value("-(4 - 9)")).toBe(5);
  });

  it("reports errors instead of throwing, so the model can correct itself", () => {
    for (const bad of [
      "1 / 0",
      "2 +",
      "(1 + 2",
      "1 + 2)",
      "",
      "1 2",
      "1e999 * 1e999",
      "1_000 + 1",
      "$100 + 1",
    ]) {
      const res = evaluateArithmetic(bad);
      expect(res.ok, `expected ${JSON.stringify(bad)} to fail`).toBe(false);
      expect(typeof res.error).toBe("string");
    }
  });

  /**
   * The expression crosses a trust boundary — it is model output. The grammar
   * can only yield a number, so these must be parse errors, never execution.
   */
  it("cannot be used to execute code", () => {
    for (const attack of [
      "process.exit(1)",
      "require('fs')",
      "globalThis",
      "constructor.constructor('return 1')()",
      "1; console.log(2)",
      "`${1}`",
    ]) {
      expect(evaluateArithmetic(attack).ok, attack).toBe(false);
    }
  });

  it("bounds expression length", () => {
    const res = evaluateArithmetic(`${"1+".repeat(400)}1`);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/exceeds/u);
  });
});
