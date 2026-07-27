import { Worker } from "bullmq";
import { and, eq } from "drizzle-orm";

import { loadModelsConfig } from "@contractix/shared";

import { env } from "./config/env.js";
import { assertEmbeddingDims } from "./db/assert.js";
import { db } from "./db/client.js";
import { documents } from "./db/schema/index.js";
import { runAnalysis } from "./extraction/analysis-service.js";
import { runIngestion } from "./ingestion/pipeline.js";
import { logger } from "./logger.js";
import { createProviders } from "./providers/index.js";
import {
  ANALYSIS_QUEUE,
  type AnalysisJobData,
  createAnalysisQueue,
  enqueueAnalysis,
} from "./queue/analysis.js";
import { assertNoEviction, createRedis } from "./queue/connection.js";
import { INGEST_QUEUE, type IngestJobData } from "./queue/ingest.js";
import {
  createRetentionQueue,
  RETENTION_QUEUE,
  type RetentionJobData,
  scheduleRetentionSweep,
} from "./queue/retention.js";
import { purgeExpiredTenants } from "./retention/purge.js";
import { LocalBlobStore } from "./storage/local.js";

// Blocking Workers each need their own connection; the analysis producer (used
// by the ingest worker to chain) needs one that no Worker is blocking on.
const ingestConnection = createRedis(env.REDIS_URL);
const analysisConnection = createRedis(env.REDIS_URL);
const retentionConnection = createRedis(env.REDIS_URL);
const producerConnection = createRedis(env.REDIS_URL);
await assertNoEviction(ingestConnection);
await assertEmbeddingDims(db);

const providers = createProviders(loadModelsConfig(), {
  envVars: process.env,
  production: env.NODE_ENV === "production",
  onFallback: (role, reason) => logger.warn({ role, reason }, "provider degraded to keyless fake"),
});

const blobStore = new LocalBlobStore(env.STORAGE_DIR);
await blobStore.init();

const analysisQueue = createAnalysisQueue(producerConnection);

// FR-7.3: sweeps anonymous sessions 24 h after they were minted.
await scheduleRetentionSweep(createRetentionQueue(producerConnection));

const ingestWorker = new Worker<IngestJobData>(
  INGEST_QUEUE,
  async (job) => {
    logger.info({ jobId: job.id, documentId: job.data.documentId }, "ingestion started");
    const { status, tenantId } = await runIngestion(
      {
        db,
        blobStore,
        embeddings: providers.embeddings,
        onStage: (stage) => {
          logger.debug({ jobId: job.id, stage }, "ingestion stage");
          return job.updateProgress({ stage });
        },
      },
      job.data.documentId,
    );
    logger.info({ jobId: job.id, documentId: job.data.documentId, status }, "ingestion finished");

    // FR-5.3: a successfully indexed document chains into analysis. A failed
    // parse never analyzes. Kept out of runIngestion so the pure pipeline stays
    // queue-agnostic and the enqueue happens only after its transaction commits.
    if (status === "ready") {
      await enqueueAnalysis(analysisQueue, { documentId: job.data.documentId, tenantId });
      logger.info({ jobId: job.id, documentId: job.data.documentId }, "analysis enqueued");
    }
  },
  { connection: ingestConnection, concurrency: 2 },
);

const analysisWorker = new Worker<AnalysisJobData>(
  ANALYSIS_QUEUE,
  async (job) => {
    logger.info({ jobId: job.id, documentId: job.data.documentId }, "analysis started");
    await runAnalysis(
      { db, llm: providers.llm },
      { documentId: job.data.documentId, tenantId: job.data.tenantId },
    );
    logger.info({ jobId: job.id, documentId: job.data.documentId }, "analysis finished");
  },
  { connection: analysisConnection, concurrency: 2 },
);

const retentionWorker = new Worker<RetentionJobData>(
  RETENTION_QUEUE,
  async () => {
    const result = await purgeExpiredTenants({ db, blobStore });
    logger.info(result, "retention sweep finished");
  },
  { connection: retentionConnection, concurrency: 1 },
);

retentionWorker.on("failed", (_job, err) => {
  logger.error({ err: err.message }, "retention sweep failed");
});

ingestWorker.on("failed", (job, err) => {
  logger.error(
    { jobId: job?.id, documentId: job?.data.documentId, err: err.message },
    "ingestion job failed",
  );
});

analysisWorker.on("failed", (job, err) => {
  logger.error(
    { jobId: job?.id, documentId: job?.data.documentId, err: err.message },
    "analysis job failed",
  );
  // Surface the terminal state only once BullMQ retries are exhausted; earlier
  // attempts stay `analyzing` because a retry is still coming.
  if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
    db.update(documents)
      .set({ analysisStatus: "failed" })
      .where(and(eq(documents.id, job.data.documentId), eq(documents.tenantId, job.data.tenantId)))
      .catch((e: unknown) =>
        logger.error(
          { documentId: job.data.documentId, err: e instanceof Error ? e.message : String(e) },
          "failed to mark analysis failed",
        ),
      );
  }
});

logger.info(
  {
    queues: [INGEST_QUEUE, ANALYSIS_QUEUE, RETENTION_QUEUE],
    embeddings: providers.embeddings.id,
    llm: providers.llm.id,
  },
  "workers started",
);
