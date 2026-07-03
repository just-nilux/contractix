import { Worker } from "bullmq";

import { loadModelsConfig } from "@contractix/shared";

import { env } from "./config/env.js";
import { db } from "./db/client.js";
import { assertEmbeddingDims } from "./db/assert.js";
import { runIngestion } from "./ingestion/pipeline.js";
import { logger } from "./logger.js";
import { createProviders } from "./providers/index.js";
import { assertNoEviction, createRedis } from "./queue/connection.js";
import { INGEST_QUEUE, type IngestJobData } from "./queue/ingest.js";
import { LocalBlobStore } from "./storage/local.js";

const connection = createRedis(env.REDIS_URL);
await assertNoEviction(connection);
await assertEmbeddingDims(db);

const providers = createProviders(loadModelsConfig(), {
  envVars: process.env,
  production: env.NODE_ENV === "production",
  onFallback: (role, reason) => logger.warn({ role, reason }, "provider degraded to keyless fake"),
});

const blobStore = new LocalBlobStore(env.STORAGE_DIR);
await blobStore.init();

const worker = new Worker<IngestJobData>(
  INGEST_QUEUE,
  async (job) => {
    logger.info({ jobId: job.id, documentId: job.data.documentId }, "ingestion started");
    await runIngestion(
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
    logger.info({ jobId: job.id, documentId: job.data.documentId }, "ingestion finished");
  },
  { connection, concurrency: 2 },
);

worker.on("failed", (job, err) => {
  logger.error(
    { jobId: job?.id, documentId: job?.data.documentId, err: err.message },
    "ingestion job failed",
  );
});

logger.info(
  { queue: INGEST_QUEUE, embeddings: providers.embeddings.id },
  "ingestion worker started",
);
