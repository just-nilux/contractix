import { and, eq } from "drizzle-orm";

import { schema, type Db } from "@contractix/api";

import { type GoldQa } from "./gold.js";

export interface ResolvedCase {
  tenantId: string;
  caseId: string;
  /** filename -> document id */
  documentsByFile: Map<string, string>;
}

export interface ResolvedGoldRef {
  documentId: string;
  clauseRef: string;
  clauseId: string;
}

const DEMO_TENANT = "demo";
const DEMO_CASE = "Demo Corpus";

export async function resolveDemoCase(db: Db): Promise<ResolvedCase> {
  const tenant = (
    await db.select().from(schema.tenants).where(eq(schema.tenants.name, DEMO_TENANT)).limit(1)
  )[0];
  if (!tenant) throw new Error("demo tenant missing - run `pnpm seed:demo` first");

  const demoCase = (
    await db
      .select()
      .from(schema.cases)
      .where(and(eq(schema.cases.tenantId, tenant.id), eq(schema.cases.title, DEMO_CASE)))
      .limit(1)
  )[0];
  if (!demoCase) throw new Error("demo case missing - run `pnpm seed:demo` first");

  const docs = await db
    .select({ id: schema.documents.id, filename: schema.documents.filename })
    .from(schema.documents)
    .where(eq(schema.documents.caseId, demoCase.id));

  return {
    tenantId: tenant.id,
    caseId: demoCase.id,
    documentsByFile: new Map(docs.map((d) => [d.filename, d.id])),
  };
}

/**
 * Gold refs are the human-writable "page:clause_path" form ("file.pdf#..."
 * for case-wide questions). An unresolvable ref is a HARD error: it means
 * corpus and labels drifted apart, and a silently-dangling gold ref would
 * quietly deflate recall forever.
 */
export async function resolveGoldRefs(
  db: Db,
  resolved: ResolvedCase,
  q: GoldQa,
): Promise<ResolvedGoldRef[]> {
  const out: ResolvedGoldRef[] = [];
  for (const raw of q.gold_clause_refs) {
    let file: string;
    let clauseRef: string;
    if (raw.includes("#")) {
      const [f, ref] = raw.split("#", 2);
      file = f ?? "";
      clauseRef = ref ?? "";
    } else {
      if (!q.doc) throw new Error(`${q.id}: case-wide question needs "file#ref" gold refs`);
      file = q.doc;
      clauseRef = raw;
    }

    const documentId = resolved.documentsByFile.get(file);
    if (!documentId) throw new Error(`${q.id}: gold ref file '${file}' not in demo case`);

    const clause = (
      await db
        .select({ id: schema.clauses.id })
        .from(schema.clauses)
        .where(
          and(eq(schema.clauses.documentId, documentId), eq(schema.clauses.clauseRef, clauseRef)),
        )
        .limit(1)
    )[0];
    if (!clause) {
      throw new Error(`${q.id}: gold ref '${raw}' does not resolve to a clause in ${file}`);
    }
    out.push({ documentId, clauseRef, clauseId: clause.id });
  }
  return out;
}
