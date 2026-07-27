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

/**
 * Which pinned model a call uses. `model` is the frontier model (agent loop,
 * report generation); `small_model` is the cheap one (classification,
 * extraction repair). Both live under `llm.primary` so the model ids stay in
 * exactly one place (ADR-0004).
 */
export const llmRoleSchema = z.enum(["model", "small_model"]);
export type LlmRole = z.infer<typeof llmRoleSchema>;

/**
 * Per-model request-shape capabilities. These are model facts, not preferences:
 * Claude Sonnet 5 and later reject a non-default `temperature`/`top_p`/`top_k`
 * with a 400, and control reasoning depth through `output_config.effort`
 * instead. Haiku 4.5 still takes `temperature: 0`, which is what pins
 * extraction determinism, so the two roles genuinely differ.
 */
export const modelParamsSchema = z.object({
  /** false ⇒ never send sampling parameters to this model. */
  sampling: z.boolean(),
  /** output_config.effort; omitted ⇒ leave the server default. */
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
});
export type ModelParams = z.infer<typeof modelParamsSchema>;

export const tokenPriceSchema = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
});
export type TokenPrice = z.infer<typeof tokenPriceSchema>;

const byRole = <T extends z.ZodTypeAny>(inner: T) => z.object({ model: inner, small_model: inner });

export const llmConfigSchema = z.object({
  primary: z.object({
    provider: z.literal("anthropic"),
    model: z.string().min(1),
    small_model: z.string().min(1),
    api_key_env: z.string().min(1),
    params: byRole(modelParamsSchema),
    /** Provider list price, USD per million tokens — verifiable upstream. */
    pricing_usd_per_mtok: byRole(tokenPriceSchema),
    /** Static by design; a per-request FX lookup would make cost irreproducible. */
    usd_to_eur: z.number().positive(),
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

/** The pinned model id for a role — the only supported way to name a model. */
export function llmModelId(cfg: LlmConfig, role: LlmRole): string {
  return cfg.primary[role];
}

export function llmParamsFor(cfg: LlmConfig, role: LlmRole): ModelParams {
  return cfg.primary.params[role];
}

/**
 * Cost of one call in EUR (PRD FR-8 budget guard, persisted per Q&A turn).
 * Derived from the provider's USD list price and the pinned FX rate rather
 * than a hand-maintained EUR price, so every number traces to a source.
 */
export function costEur(
  cfg: LlmConfig,
  role: LlmRole,
  usage: { inputTokens: number; outputTokens: number },
): number {
  const price = cfg.primary.pricing_usd_per_mtok[role];
  const usd = (usage.inputTokens * price.input + usage.outputTokens * price.output) / 1_000_000;
  return usd * cfg.primary.usd_to_eur;
}
