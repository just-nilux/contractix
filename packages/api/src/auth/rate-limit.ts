/**
 * Per-tenant and per-IP rate limits (PRD FR-6.2 "anonymous demo tenant with
 * rate limits", FR-8).
 *
 * Redis-backed rather than an in-process Map: a Map resets on every deploy,
 * which for an abuse-facing anonymous demo is exactly the wrong failure mode,
 * and it stops working the moment there are two API processes behind Caddy.
 *
 * **Fail-open.** If Redis is unreachable the request is allowed and the failure
 * is logged. A limiter that takes the public demo down when its bookkeeping
 * store hiccups has done more damage than the abuse it prevents; the Phase-4
 * per-tenant budget cap is the second line of defence for cost, which is the
 * thing actually worth protecting.
 *
 * Keys are namespaced `rl:{scope}:{id}:{bucket}:{window}` so the Phase-4
 * monthly budget guard (`budget:{tenantId}:{yyyy-mm}`) lands in this module
 * rather than growing a parallel one.
 */
import { getConnInfo } from "@hono/node-server/conninfo";
import { type Context, type MiddlewareHandler } from "hono";
import { type Redis } from "ioredis";

import { logger } from "../logger.js";
import { type AppEnv } from "./middleware.js";

export interface RateLimitRule {
  /** Requests permitted per window. */
  limit: number;
  windowSec: number;
  /** IP for routes that mint tenants - a per-tenant limit there is self-defeating. */
  scope: "ip" | "tenant";
}

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Seconds until the window resets; the exact `Retry-After`, never a guess. */
  resetSec: number;
}

export interface RateLimiter {
  check(bucket: string, id: string, rule: RateLimitRule): Promise<RateLimitDecision>;
}

/**
 * INCR and PEXPIRE in one round trip. Doing them as two commands leaks
 * immortal keys whenever the process dies between them, and returning the PTTL
 * is what makes `Retry-After` exact.
 */
const SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return {count, redis.call('PTTL', KEYS[1])}
`;

export class RedisRateLimiter implements RateLimiter {
  constructor(private readonly redis: Redis) {}

  async check(bucket: string, id: string, rule: RateLimitRule): Promise<RateLimitDecision> {
    const key = `rl:${rule.scope}:${id}:${bucket}:${rule.windowSec}`;
    try {
      const [count, ttlMs] = (await this.redis.eval(
        SCRIPT,
        1,
        key,
        String(rule.windowSec * 1000),
      )) as [number, number];

      return {
        allowed: count <= rule.limit,
        limit: rule.limit,
        remaining: Math.max(0, rule.limit - count),
        resetSec: Math.max(1, Math.ceil(ttlMs / 1000)),
      };
    } catch (err) {
      logger.warn({ err, bucket }, "rate limiter unavailable - failing open");
      return { allowed: true, limit: rule.limit, remaining: rule.limit, resetSec: 0 };
    }
  }
}

/** For unit tests and any context without Redis. Never limits. */
export class NoopRateLimiter implements RateLimiter {
  check(_bucket: string, _id: string, rule: RateLimitRule): Promise<RateLimitDecision> {
    return Promise.resolve({
      allowed: true,
      limit: rule.limit,
      remaining: rule.limit,
      resetSec: 0,
    });
  }
}

/**
 * Defaults live here rather than in env so integration tests can lower them to
 * exercise a 429 without a `if (process.env.TEST)` branch in production code.
 */
export const DEFAULT_RATE_LIMITS = {
  /** Mints a tenant, so it must be per-IP or the limit limits nothing. */
  createCase: [{ limit: 10, windowSec: 3600, scope: "ip" }],
  demoAdopt: [{ limit: 3, windowSec: 3600, scope: "ip" }],
  upload: [{ limit: 10, windowSec: 3600, scope: "tenant" }],
  /** Two windows: an hourly budget, plus a burst ceiling so one tab cannot spend it in a minute. */
  ask: [
    { limit: 20, windowSec: 3600, scope: "tenant" },
    { limit: 5, windowSec: 60, scope: "tenant" },
  ],
  analyze: [{ limit: 20, windowSec: 3600, scope: "tenant" }],
  /** A frontier call per press; tighter than analyze, which is deterministic. */
  narrative: [{ limit: 10, windowSec: 3600, scope: "tenant" }],
  read: [{ limit: 600, windowSec: 60, scope: "tenant" }],
} as const satisfies Record<string, readonly RateLimitRule[]>;

export type RateLimitBucket = keyof typeof DEFAULT_RATE_LIMITS;
export type RateLimitConfig = Record<RateLimitBucket, readonly RateLimitRule[]>;

export interface RateLimitDeps {
  rateLimiter: RateLimiter;
  rateLimits: RateLimitConfig;
}

/**
 * Behind Caddy, `x-forwarded-for` is trustworthy because Caddy sets it.
 * Exposing :3000 directly would make every IP-scoped limit forgeable - which
 * is a deployment constraint, recorded here because that is where it is felt.
 */
function clientIp(c: Context): string {
  const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded) return forwarded;
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
}

function setHeaders(c: Context, decision: RateLimitDecision): void {
  c.header("RateLimit-Limit", String(decision.limit));
  c.header("RateLimit-Remaining", String(decision.remaining));
  c.header("RateLimit-Reset", String(decision.resetSec));
}

export interface RateLimitOptions {
  /** Lets one mounted middleware cover many routes - see the read limit in app.ts. */
  skip?: (c: Context) => boolean;
}

export function rateLimit(
  deps: RateLimitDeps,
  bucket: RateLimitBucket,
  opts: RateLimitOptions = {},
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (opts.skip?.(c)) return next();
    const rules = deps.rateLimits[bucket];

    // Every rule is checked, and the tightest failure is the one reported -
    // otherwise a burst ceiling can hide behind an hourly budget.
    let strictest: RateLimitDecision | null = null;
    for (const rule of rules) {
      const id = rule.scope === "ip" ? clientIp(c) : (c.get("tenantId") ?? clientIp(c));
      const decision = await deps.rateLimiter.check(bucket, id, rule);
      if (!strictest || decision.remaining < strictest.remaining) strictest = decision;
      if (!decision.allowed) {
        setHeaders(c, decision);
        c.header("Retry-After", String(decision.resetSec));
        return c.json(
          {
            error: "rate_limited",
            scope: rule.scope,
            limit: rule.limit,
            windowSeconds: rule.windowSec,
            retryAfterSeconds: decision.resetSec,
            message: "Too many requests in this window. This is a free anonymous demo.",
          },
          429,
        );
      }
    }

    if (strictest) setHeaders(c, strictest);
    return next();
  };
}

/** Declared on every limited route so the 429 reaches /openapi.json. */
export const RATE_LIMITED_RESPONSE = {
  429: { description: "Rate limited; see Retry-After" },
} as const;
