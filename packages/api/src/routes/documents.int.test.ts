import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../app.js";
import { db, pool } from "../db/client.js";
import { type AppDeps } from "../deps.js";
import { FakeEmbeddings, FakeLlm, PassthroughReranker } from "../providers/index.js";
import { createAnalysisQueue } from "../queue/analysis.js";
import { createRedis } from "../queue/connection.js";
import { createIngestQueue, type IngestQueue } from "../queue/ingest.js";
import { LocalBlobStore } from "../storage/local.js";

// Minimal but valid single-page PDF with an embedded text string.
function tinyPdf(text: string): Uint8Array {
  const content = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const pdf = `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj
4 0 obj << /Length ${content.length} >> stream
${content}
endstream endobj
5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
trailer << /Root 1 0 R >>`;
  return new TextEncoder().encode(pdf);
}

describe("document upload", () => {
  let deps: AppDeps;
  let queue: IngestQueue;
  let redis: ReturnType<typeof createRedis>;
  let storageDir: string;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "contractix-test-"));
    redis = createRedis(process.env.REDIS_URL ?? "redis://localhost:6380");
    queue = createIngestQueue(redis);
    await queue.obliterate({ force: true }).catch(() => undefined);
    const blobStore = new LocalBlobStore(storageDir);
    await blobStore.init();
    deps = {
      db,
      blobStore,
      ingestQueue: queue,
      analysisQueue: createAnalysisQueue(redis),
      providers: {
        embeddings: new FakeEmbeddings(1024),
        reranker: new PassthroughReranker(),
        llm: new FakeLlm(),
      },
      maxUploadBytes: 25 * 1024 * 1024,
    };
    app = createApp(deps);
  });

  afterAll(async () => {
    await queue.close();
    await redis.quit();
    await fs.rm(storageDir, { recursive: true, force: true });
    await pool.end();
  });

  async function createCase(): Promise<string> {
    const res = await app.request("/cases", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "upload test case" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };
    return body.id;
  }

  function uploadRequest(caseId: string, bytes: Uint8Array, filename: string, type: string) {
    const form = new FormData();
    form.set("file", new File([bytes], filename, { type }));
    return app.request(`/cases/${caseId}/documents`, { method: "POST", body: form });
  }

  it("stores a pdf, enqueues ingestion, and dedupes identical bytes", async () => {
    const caseId = await createCase();
    const bytes = tinyPdf("Probezeit betraegt sechs Monate");

    const first = await uploadRequest(caseId, bytes, "offer.pdf", "application/pdf");
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as {
      document: { id: string; sha256: string; status: string };
      deduplicated: boolean;
    };
    expect(firstBody.deduplicated).toBe(false);
    expect(firstBody.document.status).toBe("uploaded");

    // blob exists, content-addressed
    const blobPath = path.join(storageDir, `${firstBody.document.sha256}.pdf`);
    await expect(fs.access(blobPath)).resolves.toBeUndefined();

    // job enqueued with documentId as job id
    const job = await queue.getJob(firstBody.document.id);
    expect(job?.data.documentId).toBe(firstBody.document.id);

    const second = await uploadRequest(caseId, bytes, "offer-copy.pdf", "application/pdf");
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as {
      document: { id: string };
      deduplicated: boolean;
    };
    expect(secondBody.deduplicated).toBe(true);
    expect(secondBody.document.id).toBe(firstBody.document.id);
  });

  it("rejects unsupported media types and oversized files", async () => {
    const caseId = await createCase();

    const png = await uploadRequest(caseId, new Uint8Array([1, 2, 3]), "scan.png", "image/png");
    expect(png.status).toBe(415);

    const small: AppDeps = { ...deps, maxUploadBytes: 8 };
    const smallApp = createApp(small);
    const form = new FormData();
    form.set("file", new File([tinyPdf("x")], "big.pdf", { type: "application/pdf" }));
    const big = await smallApp.request(`/cases/${caseId}/documents`, {
      method: "POST",
      body: form,
    });
    expect(big.status).toBe(413);
  });

  it("404s uploads into unknown cases", async () => {
    const res = await uploadRequest(
      "0197a3b2-1c4d-7e5f-8a9b-0c1d2e3f4a5b",
      tinyPdf("x"),
      "x.pdf",
      "application/pdf",
    );
    expect(res.status).toBe(404);
  });
});
