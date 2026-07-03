export interface QuestionResult {
  id: string;
  hit: boolean;
  /** 1-based rank of the first gold clause in the deduped top-k, null if absent */
  firstGoldRank: number | null;
  goldFound: number;
  goldTotal: number;
  latencyMs: number;
}

export interface RetrievalMetrics {
  n: number;
  recallAtK: number;
  mrrAtK: number;
  allGoldCoverageAtK: number;
  p95LatencyMs: number;
}

/** recall@k = share of questions with ANY gold clause in the top-k (PRD E-2). */
export function computeMetrics(results: readonly QuestionResult[]): RetrievalMetrics {
  const n = results.length;
  if (n === 0) throw new Error("no results to score");
  const recallAtK = results.filter((r) => r.hit).length / n;
  const mrrAtK =
    results.reduce((acc, r) => acc + (r.firstGoldRank ? 1 / r.firstGoldRank : 0), 0) / n;
  const allGoldCoverageAtK = results.filter((r) => r.goldFound === r.goldTotal).length / n;
  const latencies = [...results.map((r) => r.latencyMs)].sort((a, b) => a - b);
  const p95LatencyMs = latencies[Math.min(latencies.length - 1, Math.ceil(0.95 * n) - 1)] ?? 0;
  return { n, recallAtK, mrrAtK, allGoldCoverageAtK, p95LatencyMs };
}
