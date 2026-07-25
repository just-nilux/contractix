/**
 * Rules / red-flag eval (PRD FR-4, E-2): corpus-level precision / recall / F1 of
 * the deterministic rules engine against human-labeled expected flags, over each
 * demo doc's ground-truth extraction.
 *
 *   pnpm eval:rules                       score, print, write results
 *   pnpm eval:rules -- --gate             + fail on regression vs baseline
 *   pnpm eval:rules -- --write-baseline   + pin current numbers as baseline
 *
 * Unlike the retrieval/extraction evals this needs NO API key and NO Postgres:
 * the engine is a pure function of the extraction, so we reconstruct each doc's
 * extraction from gold/extraction.jsonl (mirroring the rules unit tests), run the
 * engine, and compare to gold/flags.jsonl. Fully deterministic — it runs on every
 * PR, never fail-soft.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runBenchmark, rulesetVersion, type Severity } from "@contractix/rules";
import {
  type DocumentType,
  documentTypeSchema,
  type ExtractedFields,
  extractionSchemaForType,
  notFound,
} from "@contractix/shared";

import { loadExtractionGold, type GoldField } from "./extraction-gold.js";
import { computeRulesMetrics, type FlagObservation, type RulesMetrics } from "./rules-metrics.js";
import { loadFlagsGold } from "./rules-gold.js";

const PKG_ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const REPO_ROOT = path.resolve(PKG_ROOT, "../..");
const MANIFEST_PATH = path.join(REPO_ROOT, "corpus", "manifest.json");
const BASELINE_PATH = path.join(PKG_ROOT, "baselines", "rules.json");
const RESULTS_PATH = path.join(PKG_ROOT, "results", "rules-latest.json");
const HISTORY_PATH = path.join(PKG_ROOT, "history", "rules.jsonl");

/** Absolute floor guarding against a quietly-bad committed baseline. */
const F1_FLOOR = 0.9;
/** Fail when corpus F1 drops more than 2 points vs baseline. */
const MAX_REGRESSION = 0.02;

interface Baseline {
  date: string;
  git_sha: string;
  ruleset_version: string;
  docs: number;
  expected: number;
  fired: number;
  precision: number;
  recall: number;
  f1: number;
}

function gitSha(): string {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

/** Map each demo file to its document type from the corpus manifest (single source of truth). */
function loadTypeByFile(): Map<string, DocumentType> {
  const raw = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")) as {
    documents: { file: string; type: string }[];
  };
  const map = new Map<string, DocumentType>();
  for (const d of raw.documents) map.set(d.file, documentTypeSchema.parse(d.type));
  return map;
}

/**
 * Rebuild an extraction from the gold fields, mirroring the rules unit tests
 * (`mkExtraction`): every schema field starts `not_found`, then gold overrides —
 * present fields become `extracted`, gold `not_found` fields stay `not_found`.
 */
function reconstruct(type: DocumentType, fields: GoldField[]): ExtractedFields {
  const ex: ExtractedFields = {};
  for (const key of extractionSchemaForType(type)?.fieldKeys ?? []) ex[key] = notFound();
  for (const g of fields) {
    ex[g.field] = g.not_found
      ? notFound()
      : {
          value: g.value,
          confidence: "high",
          citations: [],
          verbatim_anchor: "",
          status: "extracted",
        };
  }
  return ex;
}

function main(): void {
  const args = process.argv.slice(2);
  const gate = args.includes("--gate");
  const writeBaseline = args.includes("--write-baseline");

  const typeByFile = loadTypeByFile();
  const extractionByDoc = groupByDoc(loadExtractionGold());
  const flagsGold = loadFlagsGold();

  const obs: FlagObservation[] = [];
  const misses: string[] = []; // expected but not fired (recall gaps)
  const falsePositives: string[] = []; // fired but not expected (precision gaps)
  const violations: string[] = []; // notExpected rules that fired, or severity mismatches

  for (const doc of flagsGold) {
    const type = typeByFile.get(doc.doc);
    if (!type) throw new Error(`flags gold doc '${doc.doc}' not in corpus manifest`);
    const goldFields = extractionByDoc.get(doc.doc);
    if (!goldFields) throw new Error(`flags gold doc '${doc.doc}' has no extraction gold`);

    const ex = reconstruct(type, goldFields);
    const fired = runBenchmark(ex, { documentType: type });
    const firedSev = new Map<string, Severity>(fired.map((f) => [f.ruleId, f.severity]));
    const firedIds = new Set(firedSev.keys());

    const expectedSev = new Map<string, Severity>(doc.expected.map((e) => [e.ruleId, e.severity]));
    const ids = new Set<string>([...expectedSev.keys(), ...firedIds]);

    for (const id of ids) {
      const isExpected = expectedSev.has(id);
      const isFired = firedIds.has(id);
      const severity: Severity = isFired ? firedSev.get(id)! : expectedSev.get(id)!;
      obs.push({ ruleId: id, severity, expected: isExpected, fired: isFired });

      if (isExpected && !isFired) misses.push(`${doc.doc}#${id}`);
      if (!isExpected && isFired) falsePositives.push(`${doc.doc}#${id}`);
      if (isExpected && isFired && expectedSev.get(id) !== firedSev.get(id)) {
        violations.push(
          `${doc.doc}#${id}: severity gold ${expectedSev.get(id)} != engine ${firedSev.get(id)}`,
        );
      }
    }
    for (const id of doc.notExpected) {
      if (firedIds.has(id)) violations.push(`${doc.doc}#${id}: notExpected rule fired`);
    }
  }

  const metrics = computeRulesMetrics(obs, flagsGold.length);
  printSummary(metrics, misses, falsePositives, violations);
  writeResults(metrics, misses, falsePositives);
  appendHistory(metrics);

  // Severity mismatches / notExpected violations are hard errors regardless of the numeric gate:
  // they mean the gold is stale relative to the engine and must be reconciled deliberately.
  if (violations.length > 0) {
    console.error(`[eval] RULES GOLD VIOLATIONS:\n - ${violations.join("\n - ")}`);
    process.exit(1);
  }
  if (writeBaseline) doWriteBaseline(metrics);
  if (gate) doGate(metrics);
}

function groupByDoc(gold: GoldField[]): Map<string, GoldField[]> {
  const byDoc = new Map<string, GoldField[]>();
  for (const g of gold) {
    const arr = byDoc.get(g.doc) ?? [];
    arr.push(g);
    byDoc.set(g.doc, arr);
  }
  return byDoc;
}

function pct(x: number): string {
  return x.toFixed(3);
}

function printSummary(
  m: RulesMetrics,
  misses: string[],
  falsePositives: string[],
  violations: string[],
): void {
  const lines = [
    `ruleset version:  ${rulesetVersion()}`,
    `docs / expected:  ${m.docs} docs, ${m.expected} expected flags, ${m.fired} fired`,
    `precision:        ${pct(m.overall.precision)}`,
    `recall:           ${pct(m.overall.recall)}`,
    `F1:               ${pct(m.overall.f1)}  (tp=${m.overall.tp} fp=${m.overall.fp} fn=${m.overall.fn})`,
    `  red   F1:       ${pct(m.bySeverity.red.f1)}`,
    `  amber F1:       ${pct(m.bySeverity.amber.f1)}`,
    `  info  F1:       ${pct(m.bySeverity.info.f1)}`,
    misses.length ? `misses (fn):      ${misses.join(", ")}` : "misses (fn):      none",
    falsePositives.length
      ? `false pos (fp):   ${falsePositives.join(", ")}`
      : "false pos (fp):   none",
  ];
  if (violations.length) lines.push(`violations:       ${violations.join("; ")}`);
  console.log(`\n${lines.join("\n")}\n`);

  if (process.env.GITHUB_STEP_SUMMARY) {
    const md = [
      `## Rules / red-flag eval (${m.docs} docs, ${m.expected} expected flags)`,
      "",
      "| metric | value |",
      "| --- | --- |",
      `| precision | ${pct(m.overall.precision)} |`,
      `| recall | ${pct(m.overall.recall)} |`,
      `| **F1** | **${pct(m.overall.f1)}** |`,
      `| red / amber / info F1 | ${pct(m.bySeverity.red.f1)} / ${pct(m.bySeverity.amber.f1)} / ${pct(m.bySeverity.info.f1)} |`,
      `| ruleset version | ${rulesetVersion()} |`,
    ].join("\n");
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`);
  }
}

function writeResults(m: RulesMetrics, misses: string[], falsePositives: string[]): void {
  fs.mkdirSync(path.dirname(RESULTS_PATH), { recursive: true });
  fs.writeFileSync(
    RESULTS_PATH,
    JSON.stringify(
      { rulesetVersion: rulesetVersion(), metrics: m, misses, falsePositives },
      null,
      2,
    ),
  );
}

function appendHistory(m: RulesMetrics): void {
  const entry = {
    date: new Date().toISOString(),
    git_sha: gitSha(),
    ruleset_version: rulesetVersion(),
    docs: m.docs,
    expected: m.expected,
    fired: m.fired,
    precision: m.overall.precision,
    recall: m.overall.recall,
    f1: m.overall.f1,
  };
  fs.mkdirSync(path.dirname(HISTORY_PATH), { recursive: true });
  fs.appendFileSync(HISTORY_PATH, `${JSON.stringify(entry)}\n`);
}

function doWriteBaseline(m: RulesMetrics): void {
  const baseline: Baseline = {
    date: new Date().toISOString().slice(0, 10),
    git_sha: gitSha(),
    ruleset_version: rulesetVersion(),
    docs: m.docs,
    expected: m.expected,
    fired: m.fired,
    precision: m.overall.precision,
    recall: m.overall.recall,
    f1: m.overall.f1,
  };
  fs.mkdirSync(path.dirname(BASELINE_PATH), { recursive: true });
  fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
  console.log(`[eval] baseline written: F1=${pct(m.overall.f1)} (ruleset ${m.docs} docs)`);
}

function doGate(m: RulesMetrics): void {
  if (!fs.existsSync(BASELINE_PATH)) {
    console.error("[eval] gate requested but no baseline committed");
    process.exit(1);
  }
  const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8")) as Baseline;
  const failures: string[] = [];
  if (m.overall.f1 < F1_FLOOR) {
    failures.push(`F1 ${pct(m.overall.f1)} < floor ${F1_FLOOR}`);
  }
  if (m.overall.f1 < baseline.f1 - MAX_REGRESSION) {
    failures.push(
      `F1 ${pct(m.overall.f1)} regressed > ${MAX_REGRESSION} vs baseline ${pct(baseline.f1)}`,
    );
  }
  if (baseline.ruleset_version !== rulesetVersion()) {
    failures.push(
      `ruleset version changed (${baseline.ruleset_version} -> ${rulesetVersion()}) - re-baseline deliberately`,
    );
  }
  if (failures.length > 0) {
    console.error(`[eval] GATE FAILED:\n - ${failures.join("\n - ")}`);
    process.exit(1);
  }
  console.log(`[eval] gate passed (baseline F1=${pct(baseline.f1)} from ${baseline.date})`);
}

main();
