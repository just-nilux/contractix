import { type Redis } from "ioredis";
import { describe, expect, it } from "vitest";

import { DEFAULT_RATE_LIMITS, RedisRateLimiter } from "./rate-limit.js";

/**
 * A Redis stand-in that implements exactly what the Lua script does, on a fake
 * clock. Enough to pin the counting and the TTL arithmetic; the real script
 * against the real server is covered in rate-limit.int.test.ts.
 */
class FakeRedis {
  private readonly keys = new Map<string, { count: number; expiresAtMs: number }>();
  now = 0;
  failNext = false;

  eval(
    _script: string,
    _numKeys: number,
    key: string,
    windowMs: string,
  ): Promise<[number, number]> {
    if (this.failNext) return Promise.reject(new Error("CONNREFUSED"));

    const existing = this.keys.get(key);
    const live = existing && existing.expiresAtMs > this.now ? existing : undefined;
    const count = (live?.count ?? 0) + 1;
    const expiresAtMs = live?.expiresAtMs ?? this.now + Number(windowMs);
    this.keys.set(key, { count, expiresAtMs });
    return Promise.resolve([count, expiresAtMs - this.now]);
  }
}

function limiter(fake: FakeRedis) {
  return new RedisRateLimiter(fake as unknown as Redis);
}

const RULE = { limit: 3, windowSec: 60, scope: "tenant" } as const;

describe("RedisRateLimiter", () => {
  it("allows up to the limit, then denies", async () => {
    const fake = new FakeRedis();
    const rl = limiter(fake);

    const first = await rl.check("ask", "t1", RULE);
    expect(first).toMatchObject({ allowed: true, limit: 3, remaining: 2 });

    await rl.check("ask", "t1", RULE);
    expect(await rl.check("ask", "t1", RULE)).toMatchObject({ allowed: true, remaining: 0 });
    expect(await rl.check("ask", "t1", RULE)).toMatchObject({ allowed: false, remaining: 0 });
  });

  it("counts each id, bucket and window separately", async () => {
    const fake = new FakeRedis();
    const rl = limiter(fake);

    await rl.check("ask", "t1", RULE);
    await rl.check("ask", "t1", RULE);
    await rl.check("ask", "t1", RULE);

    // Different tenant, different bucket, and a different window on the same
    // bucket all start clean - the last is what lets `ask` carry 20/h and 5/min.
    expect(await rl.check("ask", "t2", RULE)).toMatchObject({ allowed: true, remaining: 2 });
    expect(await rl.check("upload", "t1", RULE)).toMatchObject({ allowed: true, remaining: 2 });
    expect(
      await rl.check("ask", "t1", { limit: 3, windowSec: 3600, scope: "tenant" }),
    ).toMatchObject({ allowed: true, remaining: 2 });
  });

  it("reports the exact seconds left, and lets the window lapse", async () => {
    const fake = new FakeRedis();
    const rl = limiter(fake);

    await rl.check("ask", "t1", RULE);
    fake.now = 47_000;
    const mid = await rl.check("ask", "t1", RULE);
    expect(mid.resetSec).toBe(13);

    fake.now = 60_001;
    expect(await rl.check("ask", "t1", RULE)).toMatchObject({ allowed: true, remaining: 2 });
  });

  // A limiter that takes the demo down when its bookkeeping store hiccups has
  // done more damage than the abuse it prevents.
  it("fails open when redis is unreachable", async () => {
    const fake = new FakeRedis();
    fake.failNext = true;

    expect(await limiter(fake).check("ask", "t1", RULE)).toMatchObject({
      allowed: true,
      remaining: RULE.limit,
    });
  });
});

describe("DEFAULT_RATE_LIMITS", () => {
  // A per-tenant limit on a route that mints tenants limits nothing: one
  // request per fresh tenant, forever.
  it("scopes the tenant-minting routes to the IP", () => {
    expect(DEFAULT_RATE_LIMITS.createCase.every((r) => r.scope === "ip")).toBe(true);
    expect(DEFAULT_RATE_LIMITS.demoAdopt.every((r) => r.scope === "ip")).toBe(true);
  });

  it("gives ask a burst ceiling as well as an hourly budget", () => {
    const windows = DEFAULT_RATE_LIMITS.ask.map((r) => r.windowSec);
    expect(windows).toContain(3600);
    expect(windows).toContain(60);
  });
});
