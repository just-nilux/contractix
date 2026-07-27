import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadModelsConfig } from "@contractix/shared";

import { createApp } from "../app.js";
import { DEFAULT_RATE_LIMITS, NoopRateLimiter } from "../auth/rate-limit.js";
import { cookieFrom, deleteTestTenant, sessionCookie, TEST_AUTH } from "../auth/testing.js";
import { signSession } from "../auth/session.js";
import { db, pool } from "../db/client.js";
import { cases, tenants } from "../db/schema/index.js";
import { type AppDeps } from "../deps.js";
import { FakeEmbeddings, FakeLlm, PassthroughReranker } from "../providers/index.js";
import { createAnalysisQueue } from "../queue/analysis.js";
import { createRedis } from "../queue/connection.js";
import { createIngestQueue } from "../queue/ingest.js";
import { LocalBlobStore } from "../storage/local.js";

/**
 * The FR-7.4 assertion, exercised the way a browser does it: a session is a
 * signed cookie, and one session cannot see another's case.
 */
describe("anonymous sessions", () => {
  let app: ReturnType<typeof createApp>;
  let redis: ReturnType<typeof createRedis>;
  let storageDir: string;
  const mintedTenants: string[] = [];

  async function newSession(title: string): Promise<{ cookie: string; caseId: string }> {
    const res = await app.request("/cases", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title }),
    });
    expect(res.status).toBe(201);
    const caseId = ((await res.json()) as { id: string }).id;
    const cookie = cookieFrom(res);

    const owner = await db
      .select({ tenantId: cases.tenantId })
      .from(cases)
      .where(eq(cases.id, caseId));
    mintedTenants.push(owner[0]!.tenantId);
    return { cookie, caseId };
  }

  beforeAll(async () => {
    storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "contractix-session-"));
    redis = createRedis(process.env.REDIS_URL ?? "redis://localhost:6380");
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
      rateLimiter: new NoopRateLimiter(),
      rateLimits: DEFAULT_RATE_LIMITS,
    };
    app = createApp(deps);
  });

  afterAll(async () => {
    for (const id of mintedTenants) await deleteTestTenant(db, id);
    await fs.rm(storageDir, { recursive: true, force: true });
    await redis.quit();
    await pool.end();
  });

  it("POST /cases mints a session and sets an HttpOnly cookie", async () => {
    const res = await app.request("/cases", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "minting" }),
    });
    expect(res.status).toBe(201);

    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("ctx_sid=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Path=/");
    // No TLS in dev, so no Secure - it is on in production (deps.auth).
    expect(setCookie).not.toContain("Secure");

    const caseId = ((await res.json()) as { id: string }).id;
    const owner = await db
      .select({ tenantId: cases.tenantId })
      .from(cases)
      .where(eq(cases.id, caseId));
    const tenantId = owner[0]!.tenantId;
    mintedTenants.push(tenantId);

    const row = await db.select().from(tenants).where(eq(tenants.id, tenantId));
    expect(row[0]!.kind).toBe("anon");
    // FR-7.3: minted with an expiry the retention job can sweep.
    expect(row[0]!.expiresAt).toBeInstanceOf(Date);
  });

  it("401s no_session without a cookie, and serves the case with one", async () => {
    const { cookie, caseId } = await newSession("scoped");

    const anonymous = await app.request(`/cases/${caseId}`);
    expect(anonymous.status).toBe(401);
    expect((await anonymous.json()) as { error: string }).toMatchObject({ error: "no_session" });

    const withSession = await app.request(`/cases/${caseId}`, { headers: { cookie } });
    expect(withSession.status).toBe(200);
  });

  it("401s session_expired for a cookie that no longer verifies", async () => {
    const expired = await signSession(
      "0197a3b2-1c4d-7e5f-8a9b-0c1d2e3f4a5b",
      TEST_AUTH.secret,
      -60,
    );
    const res = await app.request("/cases/0197a3b2-1c4d-7e5f-8a9b-0c1d2e3f4a5b", {
      headers: { cookie: `ctx_sid=${expired}` },
    });
    expect(res.status).toBe(401);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "session_expired" });
  });

  // A live token whose tenant row is gone is the FR-7.3 purge case: the row is
  // the authority, so the session reads as expired rather than valid.
  it("401s a valid token whose tenant has been purged", async () => {
    const { cookie, caseId } = await newSession("purged");
    const owner = await db
      .select({ tenantId: cases.tenantId })
      .from(cases)
      .where(eq(cases.id, caseId));
    await deleteTestTenant(db, owner[0]!.tenantId);

    const res = await app.request(`/cases/${caseId}`, { headers: { cookie } });
    expect(res.status).toBe(401);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "session_expired" });
  });

  it("404s another session's case rather than serving it (FR-7.4)", async () => {
    const mine = await newSession("mine");
    const theirs = await newSession("theirs");

    expect((await app.request(`/cases/${theirs.caseId}`, { headers: { cookie: mine.cookie } })).status).toBe(
      404,
    );
    expect((await app.request(`/cases/${mine.caseId}`, { headers: { cookie: theirs.cookie } })).status).toBe(
      404,
    );
  });

  // The same token, presented the way the Phase-4 MCP server will present it.
  it("accepts the session as a bearer token", async () => {
    const { caseId } = await newSession("bearer");
    const owner = await db
      .select({ tenantId: cases.tenantId })
      .from(cases)
      .where(eq(cases.id, caseId));
    const token = (await sessionCookie(owner[0]!.tenantId)).split("=")[1]!;

    const res = await app.request(`/cases/${caseId}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
  });

  it("does not mint a session on routes that only read", async () => {
    const before = await db.$count(tenants);
    expect((await app.request("/healthz")).status).toBe(200);
    expect((await app.request("/cases/0197a3b2-1c4d-7e5f-8a9b-0c1d2e3f4a5b")).status).toBe(401);
    expect(await db.$count(tenants)).toBe(before);
  });
});
