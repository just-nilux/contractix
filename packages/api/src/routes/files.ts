/**
 * The original bytes and their retained geometry - what the PDF viewer needs
 * (FR-6.1 "PDF viewer with highlighted span").
 *
 * The geometry is not recomputed here: the ingest pipeline already writes a
 * `{sha256}.blocks.json` sidecar carrying each block's bbox alongside the
 * frozen `charStart`/`charEnd` (ADR-0005). The viewer therefore resolves a
 * clause span to a rectangle client-side, with no round trip per citation and
 * no geometry in the database.
 *
 * Neither route takes a path from the client. The document row is looked up by
 * `(id, tenantId)` and the file path is derived from the row's own `sha256`,
 * so a content-addressed store plus an id lookup is not path-traversable by
 * construction.
 */
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";

import { type Block, documentLayoutSchema } from "@contractix/shared";

import { type AppEnv, requireTenant, tenantOf } from "../auth/middleware.js";
import { documents } from "../db/schema/index.js";
import { type AppDeps } from "../deps.js";
import { extensionForMime } from "../storage/local.js";

const getFile = createRoute({
  method: "get",
  path: "/documents/{id}/file",
  summary: "Original document bytes",
  description:
    "The uploaded file, for the viewer. `ETag` is the content hash - the store is " +
    "content-addressed, so the ETag is the identity rather than a proxy for it. " +
    "Range requests are not supported in v1; pdf.js probes and falls back to a whole-body " +
    "fetch, which at the 25 MB upload ceiling is fine.",
  middleware: requireTenant,
  request: { params: z.object({ id: z.uuid() }) },
  responses: {
    200: { description: "File bytes" },
    304: { description: "Not modified" },
    401: { description: "No session, or the session expired" },
    404: { description: "Not found" },
  },
});

const getLayout = createRoute({
  method: "get",
  path: "/documents/{id}/layout",
  summary: "Retained page and block geometry for highlighting",
  description:
    "Block rectangles in PDF points against the same frozen character offsets every " +
    "citation uses, so the viewer can resolve a clause span to a rectangle without a " +
    "round trip. Carries no text.",
  middleware: requireTenant,
  request: { params: z.object({ id: z.uuid() }) },
  responses: {
    200: {
      description: "Layout",
      content: { "application/json": { schema: documentLayoutSchema } },
    },
    304: { description: "Not modified" },
    401: { description: "No session, or the session expired" },
    404: { description: "Not found" },
  },
});

/** A user-supplied filename in a header is the one injection risk on this route. */
function safeFilename(filename: string): string {
  return filename.replace(/[\r\n"\\]/g, "_");
}

export function fileRoutes(deps: AppDeps) {
  const app = new OpenAPIHono<AppEnv>();

  app.openapi(getFile, async (c) => {
    const { id } = c.req.valid("param");
    const tenantId = tenantOf(c);

    const rows = await deps.db
      .select({
        sha256: documents.sha256,
        mimeType: documents.mimeType,
        byteSize: documents.byteSize,
        filename: documents.filename,
      })
      .from(documents)
      .where(and(eq(documents.id, id), eq(documents.tenantId, tenantId)))
      .limit(1);
    const doc = rows[0];
    if (!doc) return c.body(null, 404);

    const etag = `"${doc.sha256}"`;
    if (c.req.header("if-none-match") === etag) return c.body(null, 304);

    const ext = extensionForMime(doc.mimeType);
    if (!(await deps.blobStore.exists(doc.sha256, ext))) return c.body(null, 404);

    c.header("Content-Type", doc.mimeType);
    c.header("Content-Length", String(doc.byteSize));
    c.header(
      "Content-Disposition",
      `inline; filename="${safeFilename(doc.filename)}"; filename*=UTF-8''${encodeURIComponent(doc.filename)}`,
    );
    c.header("ETag", etag);
    // `private`: this is someone's salary. Immutable is honest here - the blob
    // is addressed by its own hash, so this URL's bytes can never change.
    c.header("Cache-Control", "private, max-age=3600, immutable");
    // A hostile PDF fetched same-origin should be able to do nothing at all.
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Content-Security-Policy", "default-src 'none'");

    return c.body(deps.blobStore.createReadStream(doc.sha256, ext));
  });

  app.openapi(getLayout, async (c) => {
    const { id } = c.req.valid("param");
    const tenantId = tenantOf(c);

    const rows = await deps.db
      .select({
        sha256: documents.sha256,
        mimeType: documents.mimeType,
        pageCount: documents.pageCount,
        parseReport: documents.parseReport,
      })
      .from(documents)
      .where(and(eq(documents.id, id), eq(documents.tenantId, tenantId)))
      .limit(1);
    const doc = rows[0];
    if (!doc) return c.body(null, 404);

    const etag = `"layout-${doc.sha256}"`;
    if (c.req.header("if-none-match") === etag) return c.body(null, 304);
    c.header("ETag", etag);
    c.header("Cache-Control", "private, max-age=3600, immutable");

    const empty = {
      documentId: id,
      mimeType: doc.mimeType,
      pageCount: doc.pageCount,
      geometry: false,
      pages: [],
      blocks: [],
    };

    let sidecar: Block[];
    try {
      sidecar = await deps.blobStore.readSidecar<Block[]>(doc.sha256, "blocks");
    } catch {
      // Ingested before the sidecar existed, or a format without geometry.
      // Either way the client falls back to the clause-text viewer, so this is
      // a shape the UI handles rather than an error.
      return c.json(empty, 200);
    }

    const pages = (doc.parseReport?.pages ?? []).flatMap((p) =>
      p.width && p.height ? [{ page: p.page, width: p.width, height: p.height }] : [],
    );
    const blocks = sidecar.flatMap((b) =>
      b.bbox
        ? [
            {
              page: b.page,
              x: b.bbox.x,
              y: b.bbox.y,
              width: b.bbox.width,
              height: b.bbox.height,
              charStart: b.charStart,
              charEnd: b.charEnd,
            },
          ]
        : [],
    );

    if (pages.length === 0 || blocks.length === 0) return c.json(empty, 200);
    return c.json({ ...empty, geometry: true, pages, blocks }, 200);
  });

  return app;
}
