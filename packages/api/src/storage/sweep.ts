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
 * hashes could be inserted between the query and the unlink. The window is
 * milliseconds, the store is content-addressed so re-uploading the same bytes
 * restores the file, and closing it properly means locking the documents table
 * for the duration of a filesystem walk. Recorded here rather than left for
 * someone to rediscover.
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

  const byHash = new Map(candidates.map((c) => [c.sha256, c]));
  // One query for every candidate, rather than one per hash.
  const stillReferenced = await db
    .selectDistinct({ sha256: documents.sha256 })
    .from(documents)
    .where(inArray(documents.sha256, [...byHash.keys()]));
  for (const row of stillReferenced) byHash.delete(row.sha256);

  let removed = 0;
  for (const ref of byHash.values()) {
    try {
      await blobStore.remove(ref.sha256, extensionForMime(ref.mimeType));
      removed++;
    } catch (err) {
      // A blob we cannot unlink is disk to reclaim later, not a failed delete:
      // the rows are already gone, which is what the user asked for.
      logger.warn({ err, sha256: ref.sha256 }, "could not remove unreferenced blob");
    }
  }
  return removed;
}
