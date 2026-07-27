/**
 * The seeded corpus, as a template rather than something served directly.
 *
 * `pnpm seed:demo` writes under a tenant named "demo" (kind `demo`). No session
 * ever resolves to that tenant: `POST /demo/adopt` clones the case into the
 * caller's own `anon` tenant instead. That is what makes the FR-7.4 guard a
 * single equality check, and it is why the retention purge - which targets
 * `anon` tenants - never touches the template.
 */
import { and, eq } from "drizzle-orm";

import { type Db } from "../db/client.js";
import { cases, documents } from "../db/schema/index.js";
import { DEMO_CASE_TITLE, DEMO_TENANT_NAME } from "../ingestion/seed-demo.js";

export interface DemoTemplate {
  tenantId: string;
  caseId: string;
}

/** Which seeded case is the template. Configurable so tests are hermetic. */
export interface DemoConfig {
  tenantName: string;
  caseTitle: string;
}

export const DEFAULT_DEMO_CONFIG: DemoConfig = {
  tenantName: DEMO_TENANT_NAME,
  caseTitle: DEMO_CASE_TITLE,
};

export async function findDemoTemplate(
  db: Db,
  config: DemoConfig = DEFAULT_DEMO_CONFIG,
): Promise<DemoTemplate | null> {
  const tenant = await db.query.tenants.findFirst({
    columns: { id: true },
    where: (t, { and: and_, eq: eq_ }) => and_(eq_(t.name, config.tenantName), eq_(t.kind, "demo")),
  });
  if (!tenant) return null;

  const template = await db
    .select({ id: cases.id })
    .from(cases)
    .where(and(eq(cases.tenantId, tenant.id), eq(cases.title, config.caseTitle)))
    .limit(1);
  if (!template[0]) return null;

  return { tenantId: tenant.id, caseId: template[0].id };
}

export interface DemoCatalogEntry {
  filename: string;
  type: string | null;
  language: string | null;
  pageCount: number | null;
}

/**
 * The catalogue is the one deliberate cross-tenant read in the codebase, and
 * it is bounded to metadata: filenames, types, languages, page counts. No
 * clause text, no citations, nothing derived from a document's contents.
 */
export async function demoCatalog(db: Db, template: DemoTemplate): Promise<DemoCatalogEntry[]> {
  return db
    .select({
      filename: documents.filename,
      type: documents.type,
      language: documents.language,
      pageCount: documents.pageCount,
    })
    .from(documents)
    .where(and(eq(documents.caseId, template.caseId), eq(documents.tenantId, template.tenantId)))
    .orderBy(documents.filename);
}
