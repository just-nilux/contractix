import { describe, expect, it } from "vitest";

import { chunkClause } from "./chunker.js";
import { countTokens } from "./tokens.js";

const SENTENCE =
  "Die virtuellen Optionen vesten monatlich über einen Zeitraum von vier Jahren mit einem Cliff von zwölf Monaten gemäß den Bestimmungen dieser Anlage. ";

describe("chunkClause", () => {
  it("keeps short clauses as a single chunk with absolute offsets", () => {
    const text = "§ 2 Probezeit\nDie Probezeit beträgt sechs Monate.";
    const chunks = chunkClause(text, 500);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      chunkIndex: 0,
      text,
      charStart: 500,
      charEnd: 500 + text.length,
    });
  });

  it("splits oversized clauses at sentence boundaries with bounded overlap", () => {
    const text = SENTENCE.repeat(80).trim(); // ~2.4k tokens
    const clauseStart = 1234;
    const chunks = chunkClause(text, clauseStart, { maxTokens: 400, overlapTokens: 60 });

    expect(chunks.length).toBeGreaterThan(1);

    for (const c of chunks) {
      expect(c.tokenCount).toBeLessThanOrEqual(400);
      // exact-slice invariant, in absolute coordinates
      expect(text.slice(c.charStart - clauseStart, c.charEnd - clauseStart)).toBe(c.text);
    }

    // full coverage: first at clause start, last at clause end, no holes
    expect(chunks[0]?.charStart).toBe(clauseStart);
    expect(chunks.at(-1)?.charEnd).toBe(clauseStart + text.length);
    for (let i = 1; i < chunks.length; i++) {
      const prev = chunks[i - 1];
      const cur = chunks[i];
      if (!prev || !cur) continue;
      expect(cur.charStart).toBeLessThanOrEqual(prev.charEnd); // overlap or contiguity
      expect(cur.charStart).toBeGreaterThan(prev.charStart); // strict progress
      const overlap = text.slice(cur.charStart - clauseStart, prev.charEnd - clauseStart);
      expect(countTokens(overlap)).toBeLessThanOrEqual(80); // ~overlap budget, boundary-snapped
    }
  });

  it("hard-cuts a single unbroken oversized unit without melting down", () => {
    const text = "x".repeat(20_000); // adversarial: no boundaries, BPE worst case
    const chunks = chunkClause(text, 0, { maxTokens: 300, overlapTokens: 50 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.tokenCount).toBeLessThanOrEqual(300);
    }
    expect(chunks.at(-1)?.charEnd).toBe(text.length);
  });
});
