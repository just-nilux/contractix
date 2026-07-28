import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deleteTestTenant } from "../auth/testing.js";
import { db, pool } from "../db/client.js";
import { cases, chunks, clauses, documents, tenants } from "../db/schema/index.js";
import { buildPdf } from "../ingestion/parser/__fixtures__/pdf.js";
import { runIngestion } from "../ingestion/pipeline.js";
import { FakeEmbeddings } from "../providers/index.js";
import { LocalBlobStore } from "../storage/local.js";
import { orphanedRowCount, purgeExpiredTenants } from "./purge.js";

/**
 * The nonce matters: "is this blob still referenced?" is a global question
 * across all tenants, exactly as it must be for a shared content-addressed
 * store. Byte-identical fixtures in a suite running concurrently in another
 * fork would legitimately keep this suite's blob alive.
 */
const NONCE = Math.random().toString(36).slice(2);
const DOC = (n: number) =>
  buildPdf([
    [
      { text: `Vertrag ${NONCE}-${n}`, size: 18 },
      { text: "1. Probezeit", size: 14 },
      { text: `Die Probezeit betraegt ${n} Monate ab Vertragsbeginn.`, size: 11 },
    ],
  ]);

describe("retention purge (FR-7.3)", () => {
  let storageDir: string;
  let blobStore: LocalBlobStore;
  const created: string[] = [];

  async function tenantWithDocument(opts: {
    kind: "anon" | "demo";
    expiresAt: Date | null;
    bytes: Uint8Array;
  }): Promise<{ tenantId: string; documentId: string; sha256: string }> {
    const t = await db
      .insert(tenants)
      .values({
        name: `purge-${opts.kind}-${Math.random().toString(36).slice(2)}`,
        kind: opts.kind,
        expiresAt: opts.expiresAt,
      })
      .returning({ id: tenants.id });
    const tenantId = t[0]!.id;
    created.push(tenantId);

    const c = await db
      .insert(cases)
      .values({ tenantId, title: "purge" })
      .returning({ id: cases.id });
    const stored = await blobStore.put(opts.bytes, ".pdf");
    const d = await db
      .insert(documents)
      .values({
        caseId: c[0]!.id,
        tenantId,
        sha256: stored.sha256,
        filename: "doc.pdf",
        mimeType: "application/pdf",
        byteSize: opts.bytes.byteLength,
      })
      .returning({ id: documents.id });
    await runIngestion({ db, blobStore, embeddings: new FakeEmbeddings(1024) }, d[0]!.id);

    return { tenantId, documentId: d[0]!.id, sha256: stored.sha256 };
  }

  beforeAll(async () => {
    storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "contractix-purge-"));
    blobStore = new LocalBlobStore(storageDir);
    await blobStore.init();
  });

  afterAll(async () => {
    for (const id of created) await deleteTestTenant(db, id);
    await fs.rm(storageDir, { recursive: true, force: true });
    await pool.end();
  });

  it("deletes an expired session, everything derived from it, and its blob", async () => {
    const expired = await tenantWithDocument({
      kind: "anon",
      expiresAt: new Date(Date.now() - 60_000),
      bytes: DOC(1),
    });

    expect(
      (await db.select().from(clauses).where(eq(clauses.documentId, expired.documentId))).length,
    ).toBeGreaterThan(0);
    expect(await blobStore.exists(expired.sha256, ".pdf")).toBe(true);

    const result = await purgeExpiredTenants({ db, blobStore });
    expect(result.tenants).toBeGreaterThanOrEqual(1);

    expect(await db.select().from(tenants).where(eq(tenants.id, expired.tenantId))).toHaveLength(0);
    expect(
      await db.select().from(documents).where(eq(documents.id, expired.documentId)),
    ).toHaveLength(0);
    expect(
      await db.select().from(clauses).where(eq(clauses.documentId, expired.documentId)),
    ).toHaveLength(0);
    expect(
      await db.select().from(chunks).where(eq(chunks.documentId, expired.documentId)),
    ).toHaveLength(0);
    expect(await blobStore.exists(expired.sha256, ".pdf")).toBe(false);

    // FR-7.3 asks for the deletion to be verified, not just performed.
    expect(await orphanedRowCount(db)).toBe(0);
  });

  it("leaves a session that has not expired yet", async () => {
    const live = await tenantWithDocument({
      kind: "anon",
      expiresAt: new Date(Date.now() + 60 * 60_000),
      bytes: DOC(2),
    });

    await purgeExpiredTenants({ db, blobStore });

    expect(await db.select().from(tenants).where(eq(tenants.id, live.tenantId))).toHaveLength(1);
    expect(await blobStore.exists(live.sha256, ".pdf")).toBe(true);
  });

  // Getting this wrong would silently break the demo a day after deploying:
  // every session clones from the template, and the template has no expiry.
  it("never touches the demo template", async () => {
    const template = await tenantWithDocument({
      kind: "demo",
      expiresAt: null,
      bytes: DOC(3),
    });

    await purgeExpiredTenants({ db, blobStore });

    expect(await db.select().from(tenants).where(eq(tenants.id, template.tenantId))).toHaveLength(
      1,
    );
    expect(
      await db.select().from(documents).where(eq(documents.id, template.documentId)),
    ).toHaveLength(1);
    expect(await blobStore.exists(template.sha256, ".pdf")).toBe(true);
  });

  // A demo clone shares the template's bytes, so purging the clone must not
  // delete the file the template still points at.
  it("keeps a blob an unexpired tenant still references", async () => {
    const shared = DOC(4);
    const keeper = await tenantWithDocument({
      kind: "anon",
      expiresAt: new Date(Date.now() + 60 * 60_000),
      bytes: shared,
    });
    await tenantWithDocument({
      kind: "anon",
      expiresAt: new Date(Date.now() - 60_000),
      bytes: shared,
    });

    await purgeExpiredTenants({ db, blobStore });

    expect(await blobStore.exists(keeper.sha256, ".pdf")).toBe(true);
    expect(await db.select().from(tenants).where(eq(tenants.id, keeper.tenantId))).toHaveLength(1);
  });

  it("is a no-op when nothing has expired", async () => {
    await purgeExpiredTenants({ db, blobStore });
    expect(await purgeExpiredTenants({ db, blobStore })).toEqual({ tenants: 0, blobs: 0 });
  });
});
