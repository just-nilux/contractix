import { Worker } from "bullmq";

import { env } from "./config/env.js";
import { db } from "./db/client.js";
import { assertEmbeddingDims } from "./db/assert.js";
import { logger } from "./logger.js";
import { assertNoEviction, createRedis } from "./queue/connection.js";
import { INGEST_QUEUE, type IngestJobData } from "./queue/ingest.js";

const connection = createRedis(env.REDIS_URL);
await assertNoEviction(connection);
await assertEmbeddingDims(db);

const worker = new Worker<IngestJobData>(
  INGEST_QUEUE,
  (job) => {
    // Pipeline stages (parse -> segment -> chunk -> embed -> persist) land next.
    logger.info({ jobId: job.id, documentId: job.data.documentId }, "ingest job received");
    return Promise.resolve();
  },
  { connection, concurrency: 2 },
);

worker.on("failed", (job, err) => {
  logger.error({ jobId: job?.id, err: err.message }, "ingest job failed");
});

logger.info({ queue: INGEST_QUEUE }, "ingestion worker started");
