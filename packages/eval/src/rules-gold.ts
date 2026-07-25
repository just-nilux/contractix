import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

/**
 * Gold red flags per document — the human-expected output of the deterministic
 * rules engine (FR-4) over each demo doc's ground-truth extraction. One line per
 * document. `expected` are the rules that must fire (with their severity, so a
 * severity change is caught); `notExpected` are near-miss rules that must NOT
 * fire (e.g. an uncapped-preference rule on a capped preference) — a documented
 * guard against over-firing beyond what plain precision already measures.
 *
 * Scope note: expected flags are those derivable from the *labeled* fields in
 * gold/extraction.jsonl — a rule cannot fire on a field the gold does not label.
 * Traps that would need an unlabeled field are gold-coverage TODOs (Phase-4
 * corpus expansion), tracked in the doc, not asserted here.
 */
const severitySchema = z.enum(["red", "amber", "info"]);

export const goldFlagSchema = z.object({
  doc: z.string().min(1),
  expected: z.array(z.object({ ruleId: z.string().min(1), severity: severitySchema })).default([]),
  notExpected: z.array(z.string().min(1)).default([]),
});
export type GoldFlags = z.infer<typeof goldFlagSchema>;

const GOLD_PATH = path.resolve(fileURLToPath(import.meta.url), "../..", "gold/flags.jsonl");

export function loadFlagsGold(filePath: string = GOLD_PATH): GoldFlags[] {
  const lines = fs.readFileSync(filePath, "utf8").trim().split("\n");
  return lines.map((line, i) => {
    try {
      return goldFlagSchema.parse(JSON.parse(line));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`flags gold line ${i + 1} invalid: ${reason}`);
    }
  });
}
