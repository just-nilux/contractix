/**
 * Deleting blobs that nothing references any more (FR-7.3).
 *
 * The store is content-addressed, so the same bytes can back documents in
 * several cases and tenants at once - a demo clone points at the very file its
 * template does. A blob may therefore only go once *no* surviving document
 * references its hash, which is a question about the whole table, not about the
 * rows being deleted.
 *
 * Callers must delete their rows first: this asks what is left.
 *
 * Residual race, accepted deliberately: a document referencing one of these
 * hashes could be inserted between the query and the unlink. Closing it
 * properly means holding a lock on the documents table for the duration of a
 * filesystem walk, which is a worse trade than the failure it prevents —
 * because the failure is bounded. The worst outcome is a row whose bytes are
 * gone, and `GET /documents/:id/file` already checks the blob exists and 404s,
 * so that reads as a missing file rather than a corrupt response; re-uploading
 * the same bytes restores it, the store being content-addressed. Recorded here
 * rather than left for someone to rediscover.
 */
import { inArray } from "drizzle-orm";

import { type Db } from "../db/client.js";
import { documents } from "../db/schema/index.js";
import { logger } from "../logger.js";
import { extensionForMime, type LocalBlobStore } from "./local.js";

export interface BlobRef {
  sha256: string;
  mimeType: string;
}

export async function sweepUnreferencedBlobs(
  db: Db,
  blobStore: LocalBlobStore,
  candidates: BlobRef[],
): Promise<number> {
  if (candidates.length === 0) return 0;

  // Keyed by hash AND mime: `extensionForMime` puts the same bytes at
  // `{sha}.pdf` or `{sha}.docx`, so collapsing on the hash alone would leave
  // one of the two files behind forever.
  const pending = new Map(candidates.map((c) => [`${c.sha256}:${c.mimeType}`, c]));
  const hashes = [...new Set(candidates.map((c) => c.sha256))];

  // One query for every candidate, rather than one per hash.
  const stillReferenced = await db
    .selectDistinct({ sha256: documents.sha256 })
    .from(documents)
    .where(inArray(documents.sha256, hashes));
  const keep = new Set(stillReferenced.map((r) => r.sha256));

  let removed = 0;
  for (const ref of pending.values()) {
    if (keep.has(ref.sha256)) continue;
    try {
      await blobStore.remove(ref.sha256, extensionForMime(ref.mimeType));
      removed++;
    } catch (err) {
      // A blob we cannot unlink is disk to reclaim later, not a failed delete:
      // the rows are already gone, which is what the caller asked for. It is
      // not retried — a retry queue for a leaked file is machinery this does
      // not earn at demo scale, and the leak is bounded by the upload ceiling.
      logger.warn({ err, sha256: ref.sha256 }, "could not remove unreferenced blob");
    }
  }
  return removed;
}
