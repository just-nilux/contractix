/**
 * Workspace-internal surface of @contractix/api (ADR-0001): the eval package
 * imports the EXACT production search path so measured numbers are honest,
 * plus the pipeline/seeding primitives. Not a public API.
 */
export { db, pool, createDb, type Db } from "./db/client.js";
export * as schema from "./db/schema/index.js";
export { ensureDevTenant } from "./db/tenancy.js";
export { runIngestion, type PipelineDeps } from "./ingestion/pipeline.js";
export {
  seedDemoCorpus,
  DEMO_CASE_TITLE,
  DEMO_TENANT_NAME,
  type SeedResult,
} from "./ingestion/seed-demo.js";
export {
  createProviders,
  FakeEmbeddings,
  FakeLlm,
  PassthroughReranker,
  type EmbeddingsProvider,
  type EmbedOptions,
  type JsonSchema,
  type LlmExtractOptions,
  type LlmExtractResult,
  type LlmProvider,
  type ProviderBundle,
  type RerankerProvider,
  type TokenUsage,
} from "./providers/index.js";
export {
  searchClauses,
  type SearchDeps,
  type SearchParams,
  type SearchResultItem,
} from "./retrieval/search-service.js";
export { extensionForMime, LocalBlobStore } from "./storage/local.js";
