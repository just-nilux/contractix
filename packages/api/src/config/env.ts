import path from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import { z } from "zod";

// Single .env at the repo root serves compose, api, and eval alike.
// dotenv never overrides variables that are already set (CI, systemd).
const repoRoot = path.resolve(fileURLToPath(import.meta.url), "../../../../..");
dotenv.config({ path: path.join(repoRoot, ".env"), quiet: true });

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  DATABASE_URL: z
    .string()
    .min(1)
    .default("postgres://contractix:contractix@localhost:5432/contractix"),
  REDIS_URL: z.string().min(1).default("redis://localhost:6379"),
  STORAGE_DIR: z.string().min(1).default("./data/files"),
  JINA_API_KEY: z.string().optional(),
  EVAL_ALLOW_LIVE_PROVIDERS: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
});

export type Env = z.infer<typeof envSchema>;

export const env: Env = envSchema.parse(process.env);
