/**
 * Phase-2 exit artifact: extract + benchmark every demo document and write a
 * red-flag report. Keyless (fake LLM) proves the pipeline end to end but yields
 * no flags — real red flags need ANTHROPIC_API_KEY. Output goes to ./data
 * (gitignored); a live run's report is the committed evidence.
 *
 *   pnpm demo:extract            # keyless plumbing check
 *   ANTHROPIC_API_KEY=... pnpm demo:extract
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadModelsConfig } from "@contractix/shared";

import { createDb } from "../db/client.js";
import { benchmarkDocument } from "../extraction/benchmark-service.js";
import { runExtraction } from "../extraction/extraction-service.js";
import { seedDemoCorpus } from "../ingestion/seed-demo.js";
import { createProviders } from "../providers/index.js";
import { LocalBlobStore } from "../storage/local.js";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../../../../..");

function severityRank(s: string): number {
  return s === "red" ? 0 : s === "amber" ? 1 : 2;
}

async function main(): Promise<void> {
  const providers = createProviders(loadModelsConfig(), {
    envVars: process.env,
    production: false,
    onFallback: (role, reason) => console.warn(`[demo] ${role}: ${reason} -> fake provider`),
  });
  const { db, pool } = createDb(
    process.env.DATABASE_URL ?? "postgres://contractix:contractix@localhost:5433/contractix",
  );
  const blobStore = new LocalBlobStore(process.env.STORAGE_DIR ?? path.join(ROOT, "data", "files"));
  await blobStore.init();

  try {
    console.log(
      `[demo] seeding (llm: ${providers.llm.id}, embeddings: ${providers.embeddings.id})`,
    );
    const seed = await seedDemoCorpus({
      db,
      blobStore,
      embeddings: providers.embeddings,
      skipReady: true,
    });

    const documents = [];
    let totalFlags = 0;
    for (const doc of seed.documents) {
      const extraction = await runExtraction(
        { db, llm: providers.llm },
        { documentId: doc.documentId, tenantId: seed.tenantId },
      );
      const flags = await benchmarkDocument(
        { db },
        { documentId: doc.documentId, tenantId: seed.tenantId },
      );
      totalFlags += flags.length;
      const extractedFields = extraction.extraction
        ? Object.values(extraction.extraction).filter((f) => f.status === "extracted").length
        : 0;
      documents.push({
        file: doc.file,
        documentType: extraction.documentType,
        schemaVer: extraction.schemaVer,
        extractedFields,
        flags: flags
          .map((f) => ({
            ruleId: f.ruleId,
            severity: f.severity,
            clauseCount: f.clauseIds.length,
            rationale: f.rationale,
          }))
          .sort((a, b) => severityRank(a.severity) - severityRank(b.severity)),
      });
      console.log(`[demo] ${doc.file}: ${extractedFields} fields, ${flags.length} flags`);
    }

    const outDir = path.join(ROOT, "data");
    await fs.mkdir(outDir, { recursive: true });
    const outPath = path.join(outDir, "demo-red-flags.json");
    await fs.writeFile(
      outPath,
      `${JSON.stringify({ llm: providers.llm.id, documents }, null, 2)}\n`,
    );
    console.log(`[demo] ${totalFlags} flags total -> ${outPath}`);
    if (providers.llm.id.startsWith("fake:")) {
      console.warn(
        "[demo] KEYLESS RUN: fake extraction reports not_found for every field, so no rules fire. " +
          "Set ANTHROPIC_API_KEY for real extraction and red flags.",
      );
    }
  } finally {
    await pool.end();
  }
}

await main();
