/**
 * Extraction eval (PRD E-2/E-3): per-field accuracy, not_found precision, and
 * citation recall over the demo corpus, through the EXACT production extraction
 * path (runExtraction).
 *
 *   pnpm eval:extraction                       score, print, write results
 *   pnpm eval:extraction -- --gate             + fail on regression vs baseline
 *   pnpm eval:extraction -- --write-baseline   + pin current numbers as baseline
 *
 * Provider policy mirrors the retrieval eval: real Anthropic requires
 * EVAL_ALLOW_LIVE_PROVIDERS=true (spend interlock) and goes through the committed
 * LLM cache; keyless runs use FakeLlm (every field not_found) - allowed for
 * plumbing checks, but never gate and never write baselines.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createDb,
  createProviders,
  type Db,
  LocalBlobStore,
  runExtraction,
  schema,
  seedDemoCorpus,
  type LlmProvider,
} from "@contractix/api";
import { type ExtractedFields, loadModelsConfig } from "@contractix/shared";
import { and, eq } from "drizzle-orm";

import { loadExtractionGold } from "./extraction-gold.js";
import {
  computeExtractionMetrics,
  goldMatches,
  type ExtractionMetrics,
  type ScoredField,
} from "./extraction-metrics.js";
import { CachedLlm } from "./llm-cache.js";
import { resolveDemoCase } from "./resolve.js";

const PKG_ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const BASELINE_PATH = path.join(PKG_ROOT, "baselines", "extraction.json");
const RESULTS_PATH = path.join(PKG_ROOT, "results", "extraction-latest.json");
const HISTORY_PATH = path.join(PKG_ROOT, "history", "extraction.jsonl");

/** Absolute floor guarding against a quietly-bad committed baseline. */
const ACCURACY_FLOOR = 0.8;
/** PRD E-3: fail when extraction accuracy drops more than 2 points vs baseline. */
const MAX_REGRESSION = 0.02;

interface Baseline {
  date: string;
  git_sha: string;
  llm: string;
  n: number;
  extraction_accuracy: number;
  overall_accuracy: number;
  not_found_precision: number;
  hallucination_rate: number;
  citation_recall: number;
}

function gitSha(): string {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const gate = args.includes("--gate");
  const writeBaseline = args.includes("--write-baseline");

  const cfg = loadModelsConfig();
  const providers = createProviders(cfg, {
    envVars: process.env,
    production: false,
    onFallback: (role, reason) => console.warn(`[eval] ${role}: ${reason} -> fake provider`),
  });

  const live = !providers.llm.id.startsWith("fake:");
  if (live && process.env.EVAL_ALLOW_LIVE_PROVIDERS !== "true") {
    console.error(
      "[eval] ANTHROPIC_API_KEY is set but EVAL_ALLOW_LIVE_PROVIDERS != true.\n" +
        "       Live extraction spends API quota - set EVAL_ALLOW_LIVE_PROVIDERS=true to consent.",
    );
    process.exit(2);
  }
  if (!live) {
    console.warn(
      "[eval] KEYLESS RUN: FakeLlm reports not_found for every field. " +
        "Numbers are plumbing-only and NOT comparable to the baseline.",
    );
    if (gate || writeBaseline) {
      console.error("[eval] --gate/--write-baseline require real providers.");
      process.exit(2);
    }
  }

  const llm: LlmProvider = live ? new CachedLlm(providers.llm) : providers.llm;
  const { db, pool } = createDb(
    process.env.DATABASE_URL ?? "postgres://contractix:contractix@localhost:5433/contractix",
  );

  try {
    const blobStore = new LocalBlobStore(process.env.STORAGE_DIR ?? "./data/files");
    await blobStore.init();
    console.log(`[eval] seeding demo corpus (llm: ${llm.id})`);
    await seedDemoCorpus({ db, blobStore, embeddings: providers.embeddings, skipReady: true });

    const resolved = await resolveDemoCase(db);
    const gold = loadExtractionGold();
    const byDoc = new Map<string, typeof gold>();
    for (const g of gold) {
      const arr = byDoc.get(g.doc) ?? [];
      arr.push(g);
      byDoc.set(g.doc, arr);
    }
    console.log(`[eval] ${gold.length} gold fields across ${byDoc.size} documents`);

    const scored: ScoredField[] = [];
    const misses: string[] = [];

    for (const [file, fields] of byDoc) {
      const documentId = resolved.documentsByFile.get(file);
      if (!documentId) throw new Error(`gold doc '${file}' not in demo case`);

      const extraction = await runExtraction(
        { db, llm },
        { documentId, tenantId: resolved.tenantId },
      );
      const ex: ExtractedFields = extraction.extraction ?? {};

      // Per-document lookups for citation scoring.
      const exRows = await db
        .select({ id: schema.extractions.id, fieldPath: schema.extractions.fieldPath })
        .from(schema.extractions)
        .where(
          and(
            eq(schema.extractions.documentId, documentId),
            eq(schema.extractions.tenantId, resolved.tenantId),
          ),
        );
      const exIdByField = new Map(exRows.map((r) => [r.fieldPath, r.id]));
      const citeRows = await db
        .select({
          extractionId: schema.citations.extractionId,
          clauseId: schema.citations.clauseId,
        })
        .from(schema.citations)
        .where(
          and(
            eq(schema.citations.documentId, documentId),
            eq(schema.citations.tenantId, resolved.tenantId),
          ),
        );
      const clausesByExtraction = new Map<string, Set<string>>();
      for (const c of citeRows) {
        if (!c.extractionId) continue;
        const set = clausesByExtraction.get(c.extractionId) ?? new Set<string>();
        set.add(c.clauseId);
        clausesByExtraction.set(c.extractionId, set);
      }
      const clauseIdByPath = await loadClausePaths(db, documentId, resolved.tenantId);

      for (const g of fields) {
        const actual = ex[g.field];
        const extracted = actual?.status === "extracted";
        const valueMatch =
          actual !== undefined && extracted && !g.not_found
            ? goldMatches(g.value, actual.value)
            : false;

        // Resolve gold clause_paths to clause ids (hard error on drift).
        const goldClauseIds = g.citations.map((cp) => {
          const id = clauseIdByPath.get(cp);
          if (!id) throw new Error(`gold citation '${cp}' does not resolve in ${file}#${g.field}`);
          return id;
        });
        const exId = exIdByField.get(g.field);
        const actualClauseIds: Set<string> = exId
          ? (clausesByExtraction.get(exId) ?? new Set<string>())
          : new Set<string>();
        const citationHits = goldClauseIds.filter((id) => actualClauseIds.has(id)).length;

        scored.push({
          goldNotFound: g.not_found,
          extracted,
          valueMatch,
          goldCitations: g.not_found ? 0 : goldClauseIds.length,
          citationHits: g.not_found ? 0 : citationHits,
        });
        if (!g.not_found && !(extracted && valueMatch)) misses.push(`${file}#${g.field}`);
      }
    }

    const metrics = computeExtractionMetrics(scored);
    printSummary(metrics, llm.id, misses);
    writeResults(metrics, misses, llm.id);
    appendHistory(metrics, live, llm.id);

    if (writeBaseline) doWriteBaseline(metrics, llm.id);
    if (gate) doGate(metrics, llm.id);
  } finally {
    await pool.end();
  }
}

async function loadClausePaths(
  db: Db,
  documentId: string,
  tenantId: string,
): Promise<Map<string, string>> {
  const rows = await db
    .select({ id: schema.clauses.id, clausePath: schema.clauses.clausePath })
    .from(schema.clauses)
    .where(and(eq(schema.clauses.documentId, documentId), eq(schema.clauses.tenantId, tenantId)));
  return new Map(rows.map((r) => [r.clausePath, r.id]));
}

function printSummary(metrics: ExtractionMetrics, llmId: string, misses: string[]): void {
  const lines = [
    `extraction accuracy:   ${metrics.extractionAccuracy.toFixed(3)} (${metrics.presentFields} present fields)`,
    `overall accuracy:      ${metrics.overallAccuracy.toFixed(3)} (n=${metrics.n})`,
    `not_found precision:   ${metrics.notFoundPrecision.toFixed(3)}`,
    `hallucination rate:    ${metrics.hallucinationRate.toFixed(3)} (${metrics.absentFields} absent fields)`,
    `citation recall:       ${metrics.citationRecall.toFixed(3)}`,
    `llm:                   ${llmId}`,
    misses.length
      ? `misses:                ${misses.slice(0, 12).join(", ")}`
      : "misses:                none",
  ];
  console.log(`\n${lines.join("\n")}\n`);

  if (process.env.GITHUB_STEP_SUMMARY) {
    const md = [
      `## Extraction eval (n=${metrics.n})`,
      "",
      "| metric | value |",
      "| --- | --- |",
      `| extraction accuracy | **${metrics.extractionAccuracy.toFixed(3)}** |`,
      `| not_found precision | ${metrics.notFoundPrecision.toFixed(3)} |`,
      `| hallucination rate | ${metrics.hallucinationRate.toFixed(3)} |`,
      `| citation recall | ${metrics.citationRecall.toFixed(3)} |`,
      `| llm | ${llmId} |`,
    ].join("\n");
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`);
  }
}

function writeResults(metrics: ExtractionMetrics, misses: string[], llmId: string): void {
  fs.mkdirSync(path.dirname(RESULTS_PATH), { recursive: true });
  fs.writeFileSync(RESULTS_PATH, JSON.stringify({ metrics, misses, llm: llmId }, null, 2));
}

function appendHistory(metrics: ExtractionMetrics, live: boolean, llmId: string): void {
  const entry = { date: new Date().toISOString(), git_sha: gitSha(), llm: llmId, live, ...metrics };
  fs.mkdirSync(path.dirname(HISTORY_PATH), { recursive: true });
  fs.appendFileSync(HISTORY_PATH, `${JSON.stringify(entry)}\n`);
}

function doWriteBaseline(metrics: ExtractionMetrics, llmId: string): void {
  const baseline: Baseline = {
    date: new Date().toISOString().slice(0, 10),
    git_sha: gitSha(),
    llm: llmId,
    n: metrics.n,
    extraction_accuracy: metrics.extractionAccuracy,
    overall_accuracy: metrics.overallAccuracy,
    not_found_precision: metrics.notFoundPrecision,
    hallucination_rate: metrics.hallucinationRate,
    citation_recall: metrics.citationRecall,
  };
  fs.mkdirSync(path.dirname(BASELINE_PATH), { recursive: true });
  fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
  console.log(
    `[eval] baseline written: extraction_accuracy=${metrics.extractionAccuracy.toFixed(3)}`,
  );
}

function doGate(metrics: ExtractionMetrics, llmId: string): void {
  if (!fs.existsSync(BASELINE_PATH)) {
    console.error("[eval] gate requested but no baseline committed");
    process.exit(1);
  }
  const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8")) as Baseline;
  const failures: string[] = [];
  if (metrics.extractionAccuracy < ACCURACY_FLOOR) {
    failures.push(`accuracy ${metrics.extractionAccuracy.toFixed(3)} < floor ${ACCURACY_FLOOR}`);
  }
  if (metrics.extractionAccuracy < baseline.extraction_accuracy - MAX_REGRESSION) {
    failures.push(
      `accuracy ${metrics.extractionAccuracy.toFixed(3)} regressed > ${MAX_REGRESSION} vs baseline ${baseline.extraction_accuracy.toFixed(3)}`,
    );
  }
  if (baseline.llm !== llmId) {
    failures.push(
      `llm mismatch vs baseline (${baseline.llm} vs ${llmId}) - re-baseline deliberately`,
    );
  }
  if (failures.length > 0) {
    console.error(`[eval] GATE FAILED:\n - ${failures.join("\n - ")}`);
    process.exit(1);
  }
  console.log(
    `[eval] gate passed (baseline accuracy=${baseline.extraction_accuracy.toFixed(3)} from ${baseline.date})`,
  );
}

await main();
