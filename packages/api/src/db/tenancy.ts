import { eq } from "drizzle-orm";

import { type Db } from "./client.js";
import { tenants } from "./schema/index.js";

/**
 * Auth lands in Phase 3 (JWT + anonymous demo tenant). Until then every
 * request runs as a single local dev tenant, created on demand - so all
 * queries already carry the FR-7.4 tenant guard from day one.
 */
const DEV_TENANT_NAME = "dev";

export async function ensureDevTenant(db: Db): Promise<string> {
  const existing = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.name, DEV_TENANT_NAME))
    .limit(1);
  const first = existing[0];
  if (first) return first.id;

  const inserted = await db
    .insert(tenants)
    .values({ name: DEV_TENANT_NAME, kind: "user" })
    .returning({ id: tenants.id });
  const row = inserted[0];
  if (!row) throw new Error("failed to create dev tenant");
  return row.id;
}
