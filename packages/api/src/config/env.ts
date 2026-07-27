import path from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import { z } from "zod";

// Single .env at the repo root serves compose, api, and eval alike.
// dotenv never overrides variables that are already set (CI, systemd).
const repoRoot = path.resolve(fileURLToPath(import.meta.url), "../../../../..");
dotenv.config({ path: path.join(repoRoot, ".env"), quiet: true });

const DEV_SESSION_SECRET = "contractix-dev-session-secret";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  DATABASE_URL: z
    .string()
    .min(1)
    .default("postgres://contractix:contractix@localhost:5433/contractix"),
  REDIS_URL: z.string().min(1).default("redis://localhost:6380"),
  STORAGE_DIR: z.string().min(1).default("./data/files"),
  /**
   * Signs anonymous session cookies. The dev default keeps keyless CI and
   * `pnpm dev` configuration-free; production must set a real one, enforced
   * below rather than here so the message names the variable. Empty is treated
   * as unset - .env.example ships the key blank, and a blank that crashed the
   * API would be a poor welcome.
   */
  SESSION_SECRET: z
    .string()
    .optional()
    .transform((v) => v?.trim())
    .transform((v) => (v?.length ? v : DEV_SESSION_SECRET)),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(24),
  JINA_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  EVAL_ALLOW_LIVE_PROVIDERS: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
});

export type Env = z.infer<typeof envSchema>;

export const env: Env = envSchema.parse(process.env);

// A production deploy signing sessions with the committed dev secret would let
// anyone mint a cookie for any tenant. Fail at boot, not at the first request.
if (env.NODE_ENV === "production" && env.SESSION_SECRET === DEV_SESSION_SECRET) {
  throw new Error("SESSION_SECRET must be set in production (the dev default is public)");
}
