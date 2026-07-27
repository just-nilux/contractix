/**
 * FR-7.3: "Demo-tenant uploads purged after 24 h", with the deletion verified.
 *
 * Deleting the tenant row is the whole job: every derived table cascades from
 * it, which is the same property that makes an expired session's cookie stop
 * working (`sessionMiddleware` treats a live token for a missing tenant as
 * expired). Data deletion *is* the revocation mechanism, so there is nothing
 * else to invalidate.
 *
 * Only `anon` tenants expire. The `demo` template has no `expires_at`, so a
 * purge never touches the corpus every session clones from - and the test says
 * so out loud, because getting that wrong would silently break the demo a day
 * after deploying.
 *
 * Blobs are content-addressed and shared across tenants, so a file is removed
 * only once no surviving document references its hash.
 */
import { and, eq, inArray, isNotNull, lte, sql } from "drizzle-orm";

import { type Db } from "../db/client.js";
import { documents, tenants } from "../db/schema/index.js";
import { logger } from "../logger.js";
import { extensionForMime, type LocalBlobStore } from "../storage/local.js";

export interface PurgeDeps {
  db: Db;
  blobStore: LocalBlobStore;
}

export interface PurgeResult {
  tenants: number;
  blobs: number;
}

export async function purgeExpiredTenants(
  deps: PurgeDeps,
  now: Date = new Date(),
): Promise<PurgeResult> {
  const expired = await deps.db
    .select({ id: tenants.id })
    .from(tenants)
    .where(
      and(eq(tenants.kind, "anon"), isNotNull(tenants.expiresAt), lte(tenants.expiresAt, now)),
    );
  if (expired.length === 0) return { tenants: 0, blobs: 0 };

  const ids = expired.map((t) => t.id);

  // Collected before the delete: afterwards the rows are gone and there is
  // nothing left to tell us which files were involved.
  const candidates = await deps.db
    .selectDistinct({ sha256: documents.sha256, mimeType: documents.mimeType })
    .from(documents)
    .where(inArray(documents.tenantId, ids));

  await deps.db.delete(tenants).where(inArray(tenants.id, ids));

  let blobs = 0;
  for (const doc of candidates) {
    const stillReferenced = await deps.db
      .select({ id: documents.id })
      .from(documents)
      .where(eq(documents.sha256, doc.sha256))
      .limit(1);
    if (stillReferenced[0]) continue;
    await deps.blobStore.remove(doc.sha256, extensionForMime(doc.mimeType));
    blobs++;
  }

  logger.info({ tenants: ids.length, blobs }, "expired anonymous sessions purged");
  return { tenants: ids.length, blobs };
}

/** Count of rows a purge would still leave behind - the FR-7.3 "verified" half. */
export async function orphanedRowCount(db: Db): Promise<number> {
  const rows = await db.execute<{ n: number }>(sql`
    select count(*)::int as n
    from documents d
    left join tenants t on t.id = d.tenant_id
    where t.id is null
  `);
  return rows.rows[0]?.n ?? 0;
}
