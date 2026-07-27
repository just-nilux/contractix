import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadModelsConfig } from "@contractix/shared";

import { createApp } from "../app.js";
import { db, pool } from "../db/client.js";
import { type AppDeps } from "../deps.js";
import { FakeEmbeddings, FakeLlm, PassthroughReranker } from "../providers/index.js";
import { createAnalysisQueue } from "../queue/analysis.js";
import { createRedis } from "../queue/connection.js";
import { createIngestQueue } from "../queue/ingest.js";
import { DEFAULT_DEMO_CONFIG } from "../demo/template.js";
import { LocalBlobStore } from "../storage/local.js";
import { DEFAULT_RATE_LIMITS, type RateLimitConfig, RedisRateLimiter } from "./rate-limit.js";
import { deleteTestTenant, TEST_AUTH } from "./testing.js";

/** Limits live in deps, not env, precisely so a test can lower them. */
const TIGHT: RateLimitConfig = {
  ...DEFAULT_RATE_LIMITS,
  createCase: [{ limit: 2, windowSec: 60, scope: "ip" }],
};

describe("rate limiting (real redis)", () => {
  let app: ReturnType<typeof createApp>;
  let redis: ReturnType<typeof createRedis>;
  let storageDir: string;
  const mintedTenants: string[] = [];
  const ip = `10.0.0.${Math.floor(Date.now() % 250) + 1}`;

  const createCase = (title: string) =>
    app.request("/cases", {
      method: "POST",
      // The IP-scoped bucket reads x-forwarded-for, which is what Caddy sets.
      headers: { "content-type": "application/json", "x-forwarded-for": ip },
      body: JSON.stringify({ title }),
    });

  beforeAll(async () => {
    storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "contractix-rl-"));
    redis = createRedis(process.env.REDIS_URL ?? "redis://localhost:6380");
    await redis.del(`rl:ip:${ip}:createCase:60`);
    const blobStore = new LocalBlobStore(storageDir);
    await blobStore.init();

    const deps: AppDeps = {
      db,
      blobStore,
      ingestQueue: createIngestQueue(redis),
      analysisQueue: createAnalysisQueue(redis),
      providers: {
        embeddings: new FakeEmbeddings(1024),
        reranker: new PassthroughReranker(),
        llm: new FakeLlm(),
        agentLlm: new FakeLlm(),
      },
      models: loadModelsConfig(),
      maxUploadBytes: 25 * 1024 * 1024,
      auth: TEST_AUTH,
      rateLimiter: new RedisRateLimiter(redis),
      rateLimits: TIGHT,
      demo: DEFAULT_DEMO_CONFIG,
      corsOrigins: [],
    };
    app = createApp(deps);
  });

  afterAll(async () => {
    for (const id of mintedTenants) await deleteTestTenant(db, id);
    await redis.del(`rl:ip:${ip}:createCase:60`);
    await fs.rm(storageDir, { recursive: true, force: true });
    await redis.quit();
    await pool.end();
  });

  it("429s past the limit with an exact Retry-After", async () => {
    const first = await createCase("one");
    expect(first.status).toBe(201);
    expect(first.headers.get("RateLimit-Limit")).toBe("2");
    expect(first.headers.get("RateLimit-Remaining")).toBe("1");

    const second = await createCase("two");
    expect(second.status).toBe(201);
    expect(second.headers.get("RateLimit-Remaining")).toBe("0");

    const third = await createCase("three");
    expect(third.status).toBe(429);
    expect(third.headers.get("Retry-After")).toBe(third.headers.get("RateLimit-Reset"));

    const retryAfter = Number(third.headers.get("Retry-After"));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);

    expect((await third.json()) as { error: string }).toMatchObject({
      error: "rate_limited",
      scope: "ip",
      limit: 2,
      windowSeconds: 60,
    });

    for (const res of [first, second]) {
      const id = ((await res.json()) as { id: string }).id;
      const owner = await db.query.cases.findFirst({
        columns: { tenantId: true },
        where: (t, { eq }) => eq(t.id, id),
      });
      if (owner) mintedTenants.push(owner.tenantId);
    }
  });

  // The limiter runs before `ensureTenant`, so a rejected request must not
  // have minted the tenant it was rejected for - otherwise the IP limit that
  // exists to stop tenant-table flooding would itself flood it. A minted
  // session always sets a cookie, so its absence is the local proof that
  // `ensureTenant` never ran. (A global tenant count would be flaky: the
  // integration suites run in parallel forks and mint concurrently.)
  it("does not mint a tenant for a rejected request", async () => {
    const res = await createCase("rejected");
    expect(res.status).toBe(429);
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});
