/**
 * Workspace-internal surface of @contractix/api (ADR-0001): the eval package
 * imports the EXACT production search path so measured numbers are honest,
 * plus the pipeline/seeding primitives. Not a public API.
 */
export { db, pool, createDb, type Db } from "./db/client.js";
export * as schema from "./db/schema/index.js";
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
  type LlmContentBlock,
  type LlmConverseOptions,
  type LlmConverseResult,
  type LlmExtractOptions,
  type LlmExtractResult,
  type LlmMessage,
  type LlmProvider,
  type LlmToolDef,
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
export {
  runExtraction,
  type ExtractionDeps,
  type ExtractionParams,
  type ExtractionResult,
} from "./extraction/extraction-service.js";
export {
  resolveFieldCitations,
  type ClauseForCitation,
  type ResolvedCitation,
  type ResolvedField,
} from "./extraction/citation-resolver.js";
export {
  benchmarkDocument,
  type BenchmarkDeps,
  type BenchmarkParams,
  type PersistedFlag,
} from "./extraction/benchmark-service.js";
export {
  classifyDocument,
  type ClassificationResult,
  type ClassifierDeps,
  type ClassifierParams,
} from "./extraction/classifier-service.js";
export {
  runAnalysis,
  type AnalysisDeps,
  type AnalysisParams,
  type AnalysisResult,
} from "./extraction/analysis-service.js";
export {
  composeDocumentReport,
  getCaseReport,
  getDocumentReport,
  type CaseReport,
  type DocumentReport,
  type ReportDeps,
} from "./extraction/report-service.js";
