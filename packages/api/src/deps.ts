import { type Redis } from "ioredis";

import { loadModelsConfig } from "@contractix/shared";

import { env } from "./config/env.js";
import { db, type Db } from "./db/client.js";
import { logger } from "./logger.js";
import { createProviders, type ProviderBundle } from "./providers/index.js";
import { type AnalysisQueue, createAnalysisQueue } from "./queue/analysis.js";
import { assertNoEviction, createRedis } from "./queue/connection.js";
import { createIngestQueue, type IngestQueue } from "./queue/ingest.js";
import { LocalBlobStore } from "./storage/local.js";

/** PRD FR-1.1: 25 MB per document. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export interface AppDeps {
  db: Db;
  blobStore: LocalBlobStore;
  ingestQueue: IngestQueue;
  analysisQueue: AnalysisQueue;
  providers: ProviderBundle;
  maxUploadBytes: number;
}

export interface BuiltDeps extends AppDeps {
  redis: Redis;
}

export async function buildAppDeps(): Promise<BuiltDeps> {
  const redis = createRedis(env.REDIS_URL);
  await assertNoEviction(redis);

  const blobStore = new LocalBlobStore(env.STORAGE_DIR);
  await blobStore.init();

  const providers = createProviders(loadModelsConfig(), {
    envVars: process.env,
    production: env.NODE_ENV === "production",
    onFallback: (role, reason) =>
      logger.warn({ role, reason }, "provider degraded to keyless fake"),
  });

  return {
    db,
    redis,
    blobStore,
    ingestQueue: createIngestQueue(redis),
    analysisQueue: createAnalysisQueue(redis),
    providers,
    maxUploadBytes: MAX_UPLOAD_BYTES,
  };
}
