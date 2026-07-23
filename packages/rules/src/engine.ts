import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { documentTypeSchema, type ExtractedFields } from "@contractix/shared";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { CHECKS } from "./checks.js";
import { type Flag, type Rule, type RuleContext } from "./types.js";

const ruleMetaSchema = z.object({
  id: z.string().min(1),
  applies_to: z.array(documentTypeSchema).min(1),
  severity: z.enum(["red", "amber", "info"]),
  rationale: z.string().min(1),
  negotiation_hint: z.string().optional(),
  sources: z.array(z.string()),
});
const rulesFileSchema = z.object({
  version: z.string().min(1),
  rules: z.array(ruleMetaSchema).min(1),
});

const RULES_PATH = path.resolve(fileURLToPath(import.meta.url), "../rules.yaml");

interface LoadedRules {
  version: string;
  rules: Rule[];
}

let cache: LoadedRules | null = null;

function load(): LoadedRules {
  if (cache) return cache;
  const parsed = rulesFileSchema.parse(parseYaml(fs.readFileSync(RULES_PATH, "utf8")));

  // Integrity: metadata and checks must be in exact 1:1 correspondence.
  const metaIds = new Set(parsed.rules.map((r) => r.id));
  for (const id of Object.keys(CHECKS)) {
    if (!metaIds.has(id)) throw new Error(`rules: check '${id}' has no metadata in rules.yaml`);
  }
  const rules: Rule[] = parsed.rules.map((m) => {
    const check = CHECKS[m.id];
    if (!check) throw new Error(`rules: metadata '${m.id}' has no check in checks.ts`);
    const hint = m.negotiation_hint?.trim();
    return {
      id: m.id,
      appliesTo: m.applies_to,
      severity: m.severity,
      rationale: m.rationale.trim(),
      sources: m.sources,
      check,
      ...(hint ? { negotiationHint: hint } : {}),
    };
  });

  cache = { version: parsed.version, rules };
  return cache;
}

/** The pinned rule-set version (rules.yaml `version`), stamped onto every flag. */
export function rulesetVersion(): string {
  return load().version;
}

/** All rules, metadata joined with their checks. */
export function loadRules(): Rule[] {
  return load().rules;
}

/**
 * Run every applicable rule over an extraction (FR-4). Deterministic — same
 * extraction in, same flags out, in rule declaration order — and pure: no LLM,
 * no DB. clause citations are resolved from triggeringFields by the caller.
 */
export function runBenchmark(ex: ExtractedFields, ctx: RuleContext): Flag[] {
  const { version, rules } = load();
  const flags: Flag[] = [];
  for (const rule of rules) {
    if (!rule.appliesTo.includes(ctx.documentType)) continue;
    const triggeringFields = rule.check(ex, ctx);
    if (!triggeringFields) continue;
    flags.push({
      ruleId: rule.id,
      ruleVersion: version,
      severity: rule.severity,
      rationale: rule.rationale,
      sources: rule.sources,
      triggeringFields,
      ...(rule.negotiationHint ? { negotiationHint: rule.negotiationHint } : {}),
    });
  }
  return flags;
}
