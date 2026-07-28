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
  /**
   * Comma-separated allowed origins for a split-origin deploy. Empty (the
   * default) sends no CORS headers at all - Caddy serves both from one origin.
   */
  CORS_ORIGINS: z
    .string()
    .optional()
    .transform((v) =>
      (v ?? "")
        .split(",")
        .map((o) => o.trim())
        .filter(Boolean),
    )
    // `*` with `credentials: true` is the combination that hands any site a
    // visitor's session; browsers reject it, but a server that offers it has
    // already decided to. Refuse at boot rather than emit a header no browser
    // will honour and nobody will notice is broken.
    .refine((origins) => !origins.includes("*"), {
      message: "CORS_ORIGINS cannot be '*': sessions are credentialed, so origins must be explicit",
    })
    .refine(
      (origins) =>
        origins.every((o) => {
          try {
            const url = new URL(o);
            return (
              (url.protocol === "https:" || url.protocol === "http:") && o === url.origin // no path, query or trailing slash
            );
          } catch {
            return false;
          }
        }),
      {
        message: "every CORS_ORIGINS entry must be a bare http(s) origin, e.g. https://app.example",
      },
    ),
  JINA_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  EVAL_ALLOW_LIVE_PROVIDERS: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
});

export type Env = z.infer<typeof envSchema>;

export const env: Env = envSchema.parse(process.env);

/** Below this, brute-forcing an HS256 signing key is a realistic afternoon. */
const MIN_PRODUCTION_SECRET_LENGTH = 32;

// A production deploy signing sessions with the committed dev secret would let
// anyone mint a cookie for any tenant. Fail at boot, not at the first request -
// and reject a short secret too, since "not the default" is a low bar for the
// one value standing between a visitor and every other visitor's documents.
if (env.NODE_ENV === "production") {
  if (env.SESSION_SECRET === DEV_SESSION_SECRET) {
    throw new Error("SESSION_SECRET must be set in production (the dev default is public)");
  }
  if (env.SESSION_SECRET.length < MIN_PRODUCTION_SECRET_LENGTH) {
    throw new Error(
      `SESSION_SECRET must be at least ${MIN_PRODUCTION_SECRET_LENGTH} characters in production ` +
        "(generate one: openssl rand -base64 32)",
    );
  }
}
