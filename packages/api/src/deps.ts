import { type Redis } from "ioredis";

import { env } from "./config/env.js";
import { db, type Db } from "./db/client.js";
import { assertNoEviction, createRedis } from "./queue/connection.js";
import { createIngestQueue, type IngestQueue } from "./queue/ingest.js";
import { LocalBlobStore } from "./storage/local.js";

/** PRD FR-1.1: 25 MB per document. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export interface AppDeps {
  db: Db;
  blobStore: LocalBlobStore;
  ingestQueue: IngestQueue;
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

  return {
    db,
    redis,
    blobStore,
    ingestQueue: createIngestQueue(redis),
    maxUploadBytes: MAX_UPLOAD_BYTES,
  };
}
