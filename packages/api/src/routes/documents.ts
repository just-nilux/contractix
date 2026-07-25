import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";

import { ensureDevTenant } from "../db/tenancy.js";
import { cases, documents } from "../db/schema/index.js";
import { type AppDeps } from "../deps.js";
import { enqueueIngest } from "../queue/ingest.js";
import { extensionForMime } from "../storage/local.js";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const documentSchema = z.object({
  id: z.uuid(),
  caseId: z.uuid(),
  filename: z.string(),
  mimeType: z.string(),
  byteSize: z.number().int(),
  sha256: z.string(),
  status: z.enum(["uploaded", "processing", "ready", "failed"]),
  analysisStatus: z.enum(["pending", "analyzing", "analyzed", "failed"]),
  language: z.enum(["de", "en", "mixed"]).nullable(),
  pageCount: z.number().int().nullable(),
  parseReport: z.unknown().nullable(),
});

const uploadDocument = createRoute({
  method: "post",
  path: "/cases/{caseId}/documents",
  summary: "Upload a document (PDF or DOCX) into a case",
  description:
    "Content-hash idempotent: re-uploading identical bytes into the same case returns the " +
    "existing document. Scanned images require the OCR path (Phase 4) and are rejected.",
  request: {
    params: z.object({ caseId: z.uuid() }),
    body: {
      content: {
        "multipart/form-data": {
          schema: z.object({
            file: z.any().openapi({ type: "string", format: "binary" }),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: "Document stored and queued for ingestion",
      content: {
        "application/json": {
          schema: z.object({ document: documentSchema, deduplicated: z.literal(false) }),
        },
      },
    },
    200: {
      description: "Identical bytes already exist in this case",
      content: {
        "application/json": {
          schema: z.object({ document: documentSchema, deduplicated: z.literal(true) }),
        },
      },
    },
    404: { description: "Case not found" },
    413: { description: "File exceeds the 25 MB limit" },
    415: { description: "Unsupported media type" },
  },
});

const getDocument = createRoute({
  method: "get",
  path: "/documents/{id}",
  summary: "Fetch a document incl. parse report",
  request: { params: z.object({ id: z.uuid() }) },
  responses: {
    200: {
      description: "Document",
      content: { "application/json": { schema: documentSchema } },
    },
    404: { description: "Not found" },
  },
});

function resolveMime(declared: string, filename: string): string | null {
  if (declared === "application/pdf" || declared === DOCX_MIME) return declared;
  // curl and some browsers send octet-stream; fall back to the extension.
  if (declared === "application/octet-stream" || declared === "") {
    if (filename.toLowerCase().endsWith(".pdf")) return "application/pdf";
    if (filename.toLowerCase().endsWith(".docx")) return DOCX_MIME;
  }
  return null;
}

function toDocumentJson(row: typeof documents.$inferSelect) {
  return {
    id: row.id,
    caseId: row.caseId,
    filename: row.filename,
    mimeType: row.mimeType,
    byteSize: row.byteSize,
    sha256: row.sha256,
    status: row.status,
    analysisStatus: row.analysisStatus,
    language: row.language,
    pageCount: row.pageCount,
    parseReport: row.parseReport ?? null,
  };
}

export function documentRoutes(deps: AppDeps) {
  const app = new OpenAPIHono();

  app.openapi(uploadDocument, async (c) => {
    const { caseId } = c.req.valid("param");
    const tenantId = await ensureDevTenant(deps.db);

    const owningCase = await deps.db
      .select({ id: cases.id })
      .from(cases)
      .where(and(eq(cases.id, caseId), eq(cases.tenantId, tenantId)))
      .limit(1);
    if (!owningCase[0]) return c.body(null, 404);

    const body = await c.req.parseBody();
    const file = body.file;
    if (!(file instanceof File)) return c.body(null, 415);

    const mime = resolveMime(file.type, file.name);
    if (!mime) return c.body(null, 415);
    if (file.size > deps.maxUploadBytes) return c.body(null, 413);

    const bytes = new Uint8Array(await file.arrayBuffer());
    const { sha256 } = await deps.blobStore.put(bytes, extensionForMime(mime));

    const existing = await deps.db
      .select()
      .from(documents)
      .where(and(eq(documents.caseId, caseId), eq(documents.sha256, sha256)))
      .limit(1);
    const dup = existing[0];
    if (dup) {
      return c.json({ document: toDocumentJson(dup), deduplicated: true as const }, 200);
    }

    const inserted = await deps.db
      .insert(documents)
      .values({
        caseId,
        tenantId,
        sha256,
        filename: file.name,
        mimeType: mime,
        byteSize: bytes.byteLength,
      })
      .returning();
    const row = inserted[0];
    if (!row) throw new Error("document insert returned no row");

    await enqueueIngest(deps.ingestQueue, row.id);

    return c.json({ document: toDocumentJson(row), deduplicated: false as const }, 201);
  });

  app.openapi(getDocument, async (c) => {
    const { id } = c.req.valid("param");
    const tenantId = await ensureDevTenant(deps.db);
    const found = await deps.db
      .select()
      .from(documents)
      .where(and(eq(documents.id, id), eq(documents.tenantId, tenantId)))
      .limit(1);
    const row = found[0];
    if (!row) return c.body(null, 404);
    return c.json(toDocumentJson(row), 200);
  });

  return app;
}
