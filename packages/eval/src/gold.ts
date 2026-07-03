import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

export const goldQaSchema = z.object({
  id: z.string().min(1),
  /** null = case-wide question; refs then carry a "filename#" prefix */
  doc: z.string().nullable(),
  lang: z.enum(["de", "en"]),
  question: z.string().min(5),
  gold_clause_refs: z.array(z.string().min(1)).min(1),
  notes: z.string().optional(),
});
export type GoldQa = z.infer<typeof goldQaSchema>;

const GOLD_PATH = path.resolve(fileURLToPath(import.meta.url), "../..", "gold/retrieval-qa.jsonl");

export function loadGold(filePath: string = GOLD_PATH): GoldQa[] {
  const lines = fs.readFileSync(filePath, "utf8").trim().split("\n");
  const gold = lines.map((line, i) => {
    try {
      return goldQaSchema.parse(JSON.parse(line));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`gold line ${i + 1} invalid: ${reason}`);
    }
  });
  const ids = new Set(gold.map((g) => g.id));
  if (ids.size !== gold.length) throw new Error("duplicate gold ids");
  return gold;
}
