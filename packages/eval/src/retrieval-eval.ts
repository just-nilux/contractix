/**
 * Retrieval eval (PRD E-2/E-3): recall@8 + MRR@8 of gold clauses over the
 * demo corpus, measured through the EXACT production search path.
 *
 * Modes:
 *   pnpm eval:retrieval                      score, print, write results
 *   pnpm eval:retrieval -- --gate            + fail on regression vs baseline
 *   pnpm eval:retrieval -- --write-baseline  + pin current numbers as baseline
 *
 * Provider policy: real Jina requires EVAL_ALLOW_LIVE_PROVIDERS=true (spend
 * interlock); corpus/query embeddings go through the committed cache. Keyless
 * runs use fake providers - allowed for plumbing checks, but never gate and
 * never write baselines.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadModelsConfig } from "@contractix/shared";
import {
  createProviders,
  createDb,
  LocalBlobStore,
  searchClauses,
  seedDemoCorpus,
  type EmbeddingsProvider,
} from "@contractix/api";

import { CachedEmbeddings } from "./cache.js";
import { loadGold } from "./gold.js";
import { computeMetrics, type QuestionResult } from "./metrics.js";
import { resolveDemoCase, resolveGoldRefs } from "./resolve.js";

const PKG_ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const BASELINE_PATH = path.join(PKG_ROOT, "baselines", "retrieval.json");
const RESULTS_PATH = path.join(PKG_ROOT, "results", "latest.json");
const HISTORY_PATH = path.join(PKG_ROOT, "history", "retrieval.jsonl");

const K = 8;
/** Absolute floor guarding against a quietly-bad committed baseline. */
const ABSOLUTE_FLOOR = 0.85;
/** PRD E-3: fail when recall@8 drops more than 3 points vs baseline. */
const MAX_REGRESSION = 0.03;

interface Baseline {
  date: string;
  git_sha: string;
  embeddings: string;
  reranker: string;
  k: number;
  n: number;
  recall_at_8: number;
  mrr_at_8: number;
  all_gold_coverage_at_8: number;
  per_question: { id: string; hit: boolean; firstGoldRank: number | null }[];
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

  const live = !providers.embeddings.id.startsWith("fake:");
  if (live && process.env.EVAL_ALLOW_LIVE_PROVIDERS !== "true") {
    console.error(
      "[eval] JINA_API_KEY is set but EVAL_ALLOW_LIVE_PROVIDERS != true.\n" +
        "       Live eval spends API quota - set EVAL_ALLOW_LIVE_PROVIDERS=true to consent.",
    );
    process.exit(2);
  }
  if (!live) {
    console.warn(
      "[eval] KEYLESS RUN: fake embeddings + passthrough reranker. " +
        "Numbers are plumbing-only and NOT comparable to the baseline.",
    );
    if (gate || writeBaseline) {
      console.error("[eval] --gate/--write-baseline require real providers.");
      process.exit(2);
    }
  }

  const embeddings: EmbeddingsProvider = live
    ? new CachedEmbeddings(providers.embeddings)
    : providers.embeddings;

  const { db, pool } = createDb(
    process.env.DATABASE_URL ?? "postgres://contractix:contractix@localhost:5433/contractix",
  );

  try {
    const blobStore = new LocalBlobStore(process.env.STORAGE_DIR ?? "./data/files");
    await blobStore.init();
    console.log(`[eval] seeding demo corpus (embeddings: ${embeddings.id})`);
    await seedDemoCorpus({ db, blobStore, embeddings, skipReady: true });

    const resolved = await resolveDemoCase(db);
    const gold = loadGold();
    console.log(`[eval] ${gold.length} gold questions, k=${K}`);

    const results: QuestionResult[] = [];
    const detail: {
      id: string;
      question: string;
      hit: boolean;
      firstGoldRank: number | null;
      returned: string[];
    }[] = [];

    for (const q of gold) {
      const goldRefs = await resolveGoldRefs(db, resolved, q);
      const goldClauseIds = new Set(goldRefs.map((g) => g.clauseId));

      const t0 = performance.now();
      const hits = await searchClauses(
        { db, embeddings, reranker: providers.reranker },
        {
          tenantId: resolved.tenantId,
          caseId: resolved.caseId,
          documentId: q.doc ? resolved.documentsByFile.get(q.doc) : undefined,
          query: q.question,
          topK: K,
        },
      );
      const latencyMs = performance.now() - t0;

      let firstGoldRank: number | null = null;
      let goldFound = 0;
      hits.forEach((h, i) => {
        if (goldClauseIds.has(h.clauseId)) {
          goldFound++;
          firstGoldRank ??= i + 1;
        }
      });

      results.push({
        id: q.id,
        hit: firstGoldRank !== null,
        firstGoldRank,
        goldFound,
        goldTotal: goldClauseIds.size,
        latencyMs,
      });
      detail.push({
        id: q.id,
        question: q.question,
        hit: firstGoldRank !== null,
        firstGoldRank,
        returned: hits.map((h) => `${h.documentId.slice(0, 8)}:${h.clauseRef}`),
      });
    }

    const metrics = computeMetrics(results);
    const misses = results.filter((r) => !r.hit).map((r) => r.id);

    const summaryLines = [
      `recall@${K}:            ${metrics.recallAtK.toFixed(3)}`,
      `MRR@${K}:               ${metrics.mrrAtK.toFixed(3)}`,
      `all-gold coverage@${K}: ${metrics.allGoldCoverageAtK.toFixed(3)}`,
      `p95 latency:           ${metrics.p95LatencyMs.toFixed(0)} ms`,
      `providers:             ${embeddings.id} + ${providers.reranker.id}`,
      misses.length ? `misses:                ${misses.join(", ")}` : "misses:                none",
    ];
    console.log(`\n${summaryLines.join("\n")}\n`);

    if (process.env.GITHUB_STEP_SUMMARY) {
      const md = [
        `## Retrieval eval (n=${metrics.n}, k=${K})`,
        "",
        "| metric | value |",
        "| --- | --- |",
        `| recall@${K} | **${metrics.recallAtK.toFixed(3)}** |`,
        `| MRR@${K} | ${metrics.mrrAtK.toFixed(3)} |`,
        `| all-gold coverage@${K} | ${metrics.allGoldCoverageAtK.toFixed(3)} |`,
        `| p95 latency | ${metrics.p95LatencyMs.toFixed(0)} ms |`,
        `| providers | ${embeddings.id} + ${providers.reranker.id} |`,
        "",
        misses.length ? `Missed: ${misses.join(", ")}` : "No misses.",
      ].join("\n");
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`);
    }

    fs.mkdirSync(path.dirname(RESULTS_PATH), { recursive: true });
    fs.writeFileSync(RESULTS_PATH, JSON.stringify({ metrics, detail }, null, 2));

    const historyEntry = {
      date: new Date().toISOString(),
      git_sha: gitSha(),
      embeddings: embeddings.id,
      reranker: providers.reranker.id,
      live,
      ...metrics,
      ...("stats" in embeddings ? { cache: (embeddings as CachedEmbeddings).stats() } : {}),
    };
    fs.mkdirSync(path.dirname(HISTORY_PATH), { recursive: true });
    fs.appendFileSync(HISTORY_PATH, `${JSON.stringify(historyEntry)}\n`);

    if (writeBaseline) {
      const baseline: Baseline = {
        date: new Date().toISOString().slice(0, 10),
        git_sha: gitSha(),
        embeddings: embeddings.id,
        reranker: providers.reranker.id,
        k: K,
        n: metrics.n,
        recall_at_8: metrics.recallAtK,
        mrr_at_8: metrics.mrrAtK,
        all_gold_coverage_at_8: metrics.allGoldCoverageAtK,
        per_question: results.map((r) => ({
          id: r.id,
          hit: r.hit,
          firstGoldRank: r.firstGoldRank,
        })),
      };
      fs.mkdirSync(path.dirname(BASELINE_PATH), { recursive: true });
      fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
      console.log(`[eval] baseline written: recall@${K}=${metrics.recallAtK.toFixed(3)}`);
    }

    if (gate) {
      if (!fs.existsSync(BASELINE_PATH)) {
        console.error("[eval] gate requested but no baseline committed");
        process.exit(1);
      }
      const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8")) as Baseline;
      const failures: string[] = [];
      if (metrics.recallAtK < ABSOLUTE_FLOOR) {
        failures.push(`recall@${K} ${metrics.recallAtK.toFixed(3)} < floor ${ABSOLUTE_FLOOR}`);
      }
      if (metrics.recallAtK < baseline.recall_at_8 - MAX_REGRESSION) {
        failures.push(
          `recall@${K} ${metrics.recallAtK.toFixed(3)} regressed > ${MAX_REGRESSION} vs baseline ${baseline.recall_at_8.toFixed(3)}`,
        );
      }
      if (baseline.embeddings !== embeddings.id || baseline.reranker !== providers.reranker.id) {
        failures.push(
          `provider mismatch vs baseline (${baseline.embeddings}+${baseline.reranker} vs ${embeddings.id}+${providers.reranker.id}) - re-baseline deliberately`,
        );
      }
      if (failures.length > 0) {
        console.error(`[eval] GATE FAILED:\n - ${failures.join("\n - ")}`);
        process.exit(1);
      }
      console.log(
        `[eval] gate passed (baseline recall@${K}=${baseline.recall_at_8.toFixed(3)} from ${baseline.date})`,
      );
    }
  } finally {
    await pool.end();
  }
}

await main();
