/**
 * CLI wrapper around seedDemoCorpus. Providers come from models.yaml -
 * keyless mode seeds with fake embeddings (fine for dev; the eval baseline
 * requires real ones and seeds through the eval package's cached provider).
 */
import { loadModelsConfig } from "@contractix/shared";

import { env } from "../config/env.js";
import { db, pool } from "../db/client.js";
import { seedDemoCorpus } from "../ingestion/seed-demo.js";
import { logger } from "../logger.js";
import { createProviders } from "../providers/index.js";
import { LocalBlobStore } from "../storage/local.js";

const providers = createProviders(loadModelsConfig(), {
  envVars: process.env,
  production: env.NODE_ENV === "production",
  onFallback: (role, reason) => logger.warn({ role, reason }, "seeding with keyless fake provider"),
});

const blobStore = new LocalBlobStore(env.STORAGE_DIR);
await blobStore.init();

const result = await seedDemoCorpus({
  db,
  blobStore,
  embeddings: providers.embeddings,
  skipReady: process.argv.includes("--skip-ready"),
});

for (const doc of result.documents) {
  logger.info(doc, "seeded");
}
logger.info({ caseId: result.caseId, embeddings: providers.embeddings.id }, "demo corpus seeded");
await pool.end();
