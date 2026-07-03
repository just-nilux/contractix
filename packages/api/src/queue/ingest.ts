import { Queue } from "bullmq";
import { type Redis } from "ioredis";

export const INGEST_QUEUE = "ingest";

/** Job payloads carry IDs only - the pipeline re-reads state from DB + blob store. */
export interface IngestJobData {
  documentId: string;
}

export function createIngestQueue(connection: Redis) {
  return new Queue<IngestJobData>(INGEST_QUEUE, {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 5_000 },
      removeOnComplete: { count: 100 },
      // Failed jobs are kept for inspection (FR-1.5: failures are never silent).
      removeOnFail: false,
    },
  });
}

export type IngestQueue = ReturnType<typeof createIngestQueue>;

export async function enqueueIngest(queue: IngestQueue, documentId: string): Promise<string> {
  // documentId as job id: re-enqueueing the same document while a job is
  // pending is a no-op instead of a duplicate.
  const job = await queue.add("ingest", { documentId }, { jobId: documentId });
  return job.id ?? documentId;
}
