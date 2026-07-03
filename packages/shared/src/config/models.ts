import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const embeddingsConfigSchema = z.object({
  provider: z.enum(["jina", "fake"]),
  model: z.string().min(1),
  dimensions: z.number().int().positive(),
  api_key_env: z.string().min(1),
  base_url: z.url(),
});
export type EmbeddingsConfig = z.infer<typeof embeddingsConfigSchema>;

export const rerankerConfigSchema = z.object({
  provider: z.enum(["jina", "passthrough"]),
  model: z.string().min(1),
  api_key_env: z.string().min(1),
  base_url: z.url(),
});
export type RerankerConfig = z.infer<typeof rerankerConfigSchema>;

export const llmConfigSchema = z.object({
  primary: z.object({
    provider: z.literal("anthropic"),
    model: z.string().min(1),
    small_model: z.string().min(1),
    api_key_env: z.string().min(1),
  }),
  fallback: z.object({
    provider: z.literal("openai"),
    model: z.string().min(1).nullable(),
    api_key_env: z.string().min(1),
  }),
});
export type LlmConfig = z.infer<typeof llmConfigSchema>;

export const modelsConfigSchema = z.object({
  version: z.literal(1),
  embeddings: embeddingsConfigSchema,
  reranker: rerankerConfigSchema,
  llm: llmConfigSchema,
});
export type ModelsConfig = z.infer<typeof modelsConfigSchema>;

export function parseModelsConfig(yamlText: string): ModelsConfig {
  return modelsConfigSchema.parse(parseYaml(yamlText));
}

const DEFAULT_PATH = path.resolve(
  fileURLToPath(import.meta.url),
  "../../../../..", // packages/shared/src/config -> repo root
  "models.yaml",
);

export function loadModelsConfig(filePath: string = DEFAULT_PATH): ModelsConfig {
  return parseModelsConfig(fs.readFileSync(filePath, "utf8"));
}

/** Stored per chunk (FR-2.4) so re-embedding migrations are observable. */
export function embeddingsProviderId(cfg: EmbeddingsConfig): string {
  return `${cfg.provider}:${cfg.model}@${cfg.dimensions}`;
}

export function rerankerProviderId(cfg: RerankerConfig): string {
  return `${cfg.provider}:${cfg.model}`;
}
