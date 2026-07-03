import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { and, eq } from "drizzle-orm";

import { type Db } from "../db/client.js";
import { cases, documents, tenants } from "../db/schema/index.js";
import { type EmbeddingsProvider } from "../providers/index.js";
import { extensionForMime, type LocalBlobStore } from "../storage/local.js";
import { runIngestion } from "./pipeline.js";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../../../../..");
const DIST = path.join(ROOT, "corpus", "dist");

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export const DEMO_TENANT_NAME = "demo";
export const DEMO_CASE_TITLE = "Demo Corpus";

interface ManifestDoc {
  file: string;
  language: "de" | "en";
  type:
    | "employment_offer"
    | "employment_contract"
    | "vsop_esop_agreement"
    | "term_sheet"
    | "shareholders_agreement"
    | "side_letter"
    | "other";
  sha256: string;
}

export interface SeedResult {
  caseId: string;
  tenantId: string;
  documents: { file: string; documentId: string; status: string; skipped: boolean }[];
}

async function ensureDemoCase(db: Db): Promise<{ tenantId: string; caseId: string }> {
  const tenant =
    (await db.select().from(tenants).where(eq(tenants.name, DEMO_TENANT_NAME)).limit(1))[0] ??
    (await db.insert(tenants).values({ name: DEMO_TENANT_NAME, kind: "demo" }).returning())[0];
  if (!tenant) throw new Error("failed to ensure demo tenant");

  const demoCase =
    (
      await db
        .select()
        .from(cases)
        .where(and(eq(cases.tenantId, tenant.id), eq(cases.title, DEMO_CASE_TITLE)))
        .limit(1)
    )[0] ??
    (await db.insert(cases).values({ tenantId: tenant.id, title: DEMO_CASE_TITLE }).returning())[0];
  if (!demoCase) throw new Error("failed to ensure demo case");

  return { tenantId: tenant.id, caseId: demoCase.id };
}

/**
 * Seeds the demo tenant/case with the committed corpus (corpus/dist) through
 * the REAL ingestion pipeline. Re-runnable: pass skipReady to leave documents
 * that are already ready (and re-embedded with the same provider) untouched.
 */
export async function seedDemoCorpus(deps: {
  db: Db;
  blobStore: LocalBlobStore;
  embeddings: EmbeddingsProvider;
  skipReady?: boolean;
}): Promise<SeedResult> {
  const manifest = JSON.parse(
    await fs.readFile(path.join(ROOT, "corpus", "manifest.json"), "utf8"),
  ) as { documents: ManifestDoc[] };

  const { tenantId, caseId } = await ensureDemoCase(deps.db);
  const results: SeedResult["documents"] = [];

  for (const doc of manifest.documents) {
    const bytes = new Uint8Array(await fs.readFile(path.join(DIST, doc.file)));
    const mime = doc.file.endsWith(".docx") ? DOCX_MIME : "application/pdf";
    const { sha256 } = await deps.blobStore.put(bytes, extensionForMime(mime));
    if (sha256 !== doc.sha256) {
      throw new Error(`${doc.file}: dist bytes do not match manifest - regenerate the corpus`);
    }

    const existing = (
      await deps.db
        .select()
        .from(documents)
        .where(and(eq(documents.caseId, caseId), eq(documents.sha256, sha256)))
        .limit(1)
    )[0];

    let documentId: string;
    if (existing) {
      documentId = existing.id;
      if (deps.skipReady && existing.status === "ready") {
        const sameProvider = await embeddedWith(deps.db, documentId, deps.embeddings.id);
        if (sameProvider) {
          results.push({ file: doc.file, documentId, status: "ready", skipped: true });
          continue;
        }
      }
    } else {
      const inserted = await deps.db
        .insert(documents)
        .values({
          caseId,
          tenantId,
          sha256,
          filename: doc.file,
          mimeType: mime,
          byteSize: bytes.byteLength,
          // Classifier lands in Phase 2; the manifest backfills types so
          // Phase-2 extraction work can start against the demo case.
          type: doc.type,
        })
        .returning({ id: documents.id });
      documentId = inserted[0]!.id;
    }

    await runIngestion(
      { db: deps.db, blobStore: deps.blobStore, embeddings: deps.embeddings },
      documentId,
    );
    const status =
      (await deps.db.select().from(documents).where(eq(documents.id, documentId)))[0]?.status ??
      "unknown";
    results.push({ file: doc.file, documentId, status, skipped: false });
    if (status !== "ready") throw new Error(`${doc.file} did not reach ready status`);
  }

  return { caseId, tenantId, documents: results };
}

async function embeddedWith(db: Db, documentId: string, providerId: string): Promise<boolean> {
  const { chunks } = await import("../db/schema/index.js");
  const row = (
    await db
      .select({ model: chunks.embeddingModel })
      .from(chunks)
      .where(eq(chunks.documentId, documentId))
      .limit(1)
  )[0];
  return row?.model === providerId;
}
