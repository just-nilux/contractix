import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

/**
 * One gold field per line. `citations` are clause_paths within the document
 * (e.g. "§11", "sec-2.1", "anlage-1/2.1") — page-independent, resolved to clause
 * rows at eval time. Present fields (not_found=false) carry the expected value;
 * gold objects may specify only the salient keys (see goldMatches).
 */
export const goldFieldSchema = z.object({
  doc: z.string().min(1),
  field: z.string().min(1),
  not_found: z.boolean().default(false),
  value: z.unknown().optional(),
  citations: z.array(z.string().min(1)).default([]),
});
export type GoldField = z.infer<typeof goldFieldSchema>;

const GOLD_PATH = path.resolve(fileURLToPath(import.meta.url), "../..", "gold/extraction.jsonl");

export function loadExtractionGold(filePath: string = GOLD_PATH): GoldField[] {
  const lines = fs.readFileSync(filePath, "utf8").trim().split("\n");
  return lines.map((line, i) => {
    try {
      const g = goldFieldSchema.parse(JSON.parse(line));
      if (!g.not_found && g.value === undefined) {
        throw new Error("a present (not_found=false) field must carry a value");
      }
      return g;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`extraction gold line ${i + 1} invalid: ${reason}`);
    }
  });
}
