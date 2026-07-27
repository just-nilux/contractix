import { type Redis } from "ioredis";

import { loadModelsConfig, type ModelsConfig } from "@contractix/shared";

import { type AuthConfig } from "./auth/middleware.js";
import {
  DEFAULT_RATE_LIMITS,
  type RateLimitConfig,
  type RateLimiter,
  RedisRateLimiter,
} from "./auth/rate-limit.js";
import { env } from "./config/env.js";
import { DEFAULT_DEMO_CONFIG, type DemoConfig } from "./demo/template.js";
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
  /** Pinned model + pricing config; the cost of a Q&A turn is derived from it. */
  models: ModelsConfig;
  maxUploadBytes: number;
  auth: AuthConfig;
  rateLimiter: RateLimiter;
  rateLimits: RateLimitConfig;
  demo: DemoConfig;
  /** Empty means: send no CORS headers. */
  corsOrigins: string[];
}

export interface BuiltDeps extends AppDeps {
  redis: Redis;
}

export async function buildAppDeps(): Promise<BuiltDeps> {
  const redis = createRedis(env.REDIS_URL);
  await assertNoEviction(redis);

  const blobStore = new LocalBlobStore(env.STORAGE_DIR);
  await blobStore.init();

  const models = loadModelsConfig();
  const providers = createProviders(models, {
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
    models,
    maxUploadBytes: MAX_UPLOAD_BYTES,
    rateLimiter: new RedisRateLimiter(redis),
    rateLimits: DEFAULT_RATE_LIMITS,
    demo: DEFAULT_DEMO_CONFIG,
    corsOrigins: env.CORS_ORIGINS,
    auth: {
      secret: env.SESSION_SECRET,
      ttlSec: env.SESSION_TTL_HOURS * 60 * 60,
      secureCookie: env.NODE_ENV === "production",
    },
  };
}
