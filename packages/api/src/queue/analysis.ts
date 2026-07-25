import { Queue } from "bullmq";
import { type Redis } from "ioredis";

export const ANALYSIS_QUEUE = "analysis";

/** Job payloads carry IDs only — runAnalysis re-reads all document state from the DB. */
export interface AnalysisJobData {
  documentId: string;
  tenantId: string;
}

export function createAnalysisQueue(connection: Redis) {
  return new Queue<AnalysisJobData>(ANALYSIS_QUEUE, {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 5_000 },
      removeOnComplete: { count: 100 },
      // Kept for inspection (FR-1.5); enqueueAnalysis clears a retained job before re-adding.
      removeOnFail: false,
    },
  });
}

export type AnalysisQueue = ReturnType<typeof createAnalysisQueue>;

/**
 * Enqueue the analysis chain for a document. jobId = documentId, but a retained
 * completed/failed job is removed first so a re-analyze (after a schema or
 * ruleset change) supersedes the prior run; an in-flight (locked) job survives
 * the remove and dedupes the add, so a document is never analyzed twice at once.
 * Analysis stages are idempotent, so the rare concurrent duplicate is harmless.
 */
export async function enqueueAnalysis(
  queue: AnalysisQueue,
  data: AnalysisJobData,
): Promise<string> {
  await queue.remove(data.documentId).catch(() => undefined);
  const job = await queue.add("analyze", data, { jobId: data.documentId });
  return job.id ?? data.documentId;
}
