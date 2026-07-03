import { eq } from "drizzle-orm";

import { canonicalText, type ParseReport } from "@contractix/shared";

import { type Db } from "../db/client.js";
import { chunks, clauses, documents } from "../db/schema/index.js";
import { type EmbeddingsProvider } from "../providers/index.js";
import { extensionForMime, type LocalBlobStore } from "../storage/local.js";
import { chunkClause } from "./chunker/chunker.js";
import { detectClauseLanguage, detectDocumentLanguage } from "./language.js";
import { parserFor } from "./parser/index.js";
import { segmentClauses } from "./segmenter/clause-segmenter.js";

export interface PipelineDeps {
  db: Db;
  blobStore: LocalBlobStore;
  embeddings: EmbeddingsProvider;
  onStage?: (stage: "parse" | "segment" | "chunk" | "embed" | "persist") => Promise<void> | void;
}

/** FR-1.3: text-layer coverage below this sends the document to the (Phase-4) OCR path. */
const MIN_COVERAGE = 0.8;
const CHUNK_INSERT_BATCH = 500;

/**
 * One BullMQ job runs all stages as pure functions over in-memory values;
 * the final persist is a single transaction (delete old clauses -> insert
 * fresh -> flip status). A retry after any crash recomputes and rewrites -
 * no partial index is ever observable (FR-1.5).
 *
 * Failure semantics: BUSINESS failures (low coverage, unparseable content,
 * no clauses) mark the document failed and return normally - deterministic
 * re-runs would fail identically, so retrying is waste. INFRA failures
 * (db/blob/provider down) throw, letting BullMQ retry with backoff.
 */
export async function runIngestion(deps: PipelineDeps, documentId: string): Promise<void> {
  const found = await deps.db.select().from(documents).where(eq(documents.id, documentId)).limit(1);
  const doc = found[0];
  if (!doc) throw new Error(`document ${documentId} not found`);

  await deps.db.update(documents).set({ status: "processing" }).where(eq(documents.id, documentId));

  const fail = async (report: ParseReport) => {
    await deps.db
      .update(documents)
      .set({ status: "failed", parseReport: report })
      .where(eq(documents.id, documentId));
  };

  // ---- parse ----------------------------------------------------------
  await deps.onStage?.("parse");
  const parser = parserFor(doc.mimeType);
  if (!parser) {
    await fail({
      parser: "none",
      coverage: 0,
      pages: [],
      error: `no parser for mime type ${doc.mimeType}`,
    });
    return;
  }

  const bytes = await deps.blobStore.get(doc.sha256, extensionForMime(doc.mimeType));
  let parsed;
  try {
    parsed = await parser.parse(bytes);
  } catch (err) {
    await fail({
      parser: parser.id,
      coverage: 0,
      pages: [],
      error: `unparseable document: ${err instanceof Error ? err.message : String(err)}`,
    });
    return;
  }

  if (parsed.report.coverage < MIN_COVERAGE) {
    await fail({
      ...parsed.report,
      error:
        `text-layer coverage ${(parsed.report.coverage * 100).toFixed(0)}% < ` +
        `${MIN_COVERAGE * 100}% - likely scanned; requires OCR path (Phase 4)`,
    });
    return;
  }

  // Geometry sidecar for the Phase-3 highlighter; not needed in the DB.
  await deps.blobStore.writeSidecar(doc.sha256, "blocks", parsed.blocks);

  // ---- segment ---------------------------------------------------------
  await deps.onStage?.("segment");
  const canonical = canonicalText(parsed.blocks);
  const docLanguage = detectDocumentLanguage(canonical);
  const segmented = segmentClauses(parsed.blocks, canonical);
  if (segmented.length === 0) {
    await fail({ ...parsed.report, error: "no clauses could be segmented" });
    return;
  }

  // ---- chunk -----------------------------------------------------------
  await deps.onStage?.("chunk");
  const chunkRows = segmented.flatMap((clause) => {
    const language = detectClauseLanguage(clause.text, docLanguage);
    return chunkClause(clause.text, clause.charStart).map((c) => ({
      clausePath: clause.clausePath,
      chunkIndex: c.chunkIndex,
      text: c.text,
      charStart: c.charStart,
      charEnd: c.charEnd,
      tokenCount: c.tokenCount,
      language,
    }));
  });

  // ---- embed -----------------------------------------------------------
  await deps.onStage?.("embed");
  const vectors = await deps.embeddings.embed(
    chunkRows.map((c) => c.text),
    { inputType: "document" },
  );
  if (vectors.length !== chunkRows.length) {
    throw new Error(`embedding count mismatch: ${vectors.length} != ${chunkRows.length}`);
  }

  // ---- persist (one transaction; FR-1.5 structural) ----------------------
  await deps.onStage?.("persist");
  await deps.db.transaction(async (tx) => {
    await tx.delete(clauses).where(eq(clauses.documentId, documentId));

    const insertedClauses = await tx
      .insert(clauses)
      .values(
        segmented.map((s) => ({
          documentId,
          tenantId: doc.tenantId,
          clauseRef: s.clauseRef,
          clausePath: s.clausePath,
          heading: s.heading,
          headingPath: s.headingPath,
          page: s.page,
          charStart: s.charStart,
          charEnd: s.charEnd,
          text: s.text,
          seq: s.seq,
        })),
      )
      .returning({ id: clauses.id, clausePath: clauses.clausePath });
    const clauseIdByPath = new Map(insertedClauses.map((c) => [c.clausePath, c.id]));

    for (let i = 0; i < chunkRows.length; i += CHUNK_INSERT_BATCH) {
      const batch = chunkRows.slice(i, i + CHUNK_INSERT_BATCH);
      await tx.insert(chunks).values(
        batch.map((c, j) => {
          const clauseId = clauseIdByPath.get(c.clausePath);
          if (!clauseId) throw new Error(`no clause id for path ${c.clausePath}`);
          const embedding = vectors[i + j];
          if (!embedding) throw new Error(`missing embedding at index ${i + j}`);
          return {
            clauseId,
            documentId,
            caseId: doc.caseId,
            tenantId: doc.tenantId,
            chunkIndex: c.chunkIndex,
            text: c.text,
            charStart: c.charStart,
            charEnd: c.charEnd,
            tokenCount: c.tokenCount,
            language: c.language,
            embedding,
            embeddingModel: deps.embeddings.id,
          };
        }),
      );
    }

    await tx
      .update(documents)
      .set({
        status: "ready",
        pageCount: parsed.pageCount,
        language: docLanguage,
        parseReport: parsed.report,
      })
      .where(eq(documents.id, documentId));
  });
}
