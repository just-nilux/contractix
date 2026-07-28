/**
 * Clones the seeded demo case into a visiting session's own tenant.
 *
 * The alternative - serving the demo tenant read-only to everyone - is cheaper
 * on disk and much worse everywhere else. It turns FR-7.4's "single `tenant_id`
 * guard in every query" into set membership at ~30 query sites, forever, and
 * the one site someone forgets to widen is a cross-tenant leak. Cloning keeps
 * the invariant literally true, and buys the thing a read-only tenant cannot:
 * the visitor can ask questions, re-run analysis, upload their own contract
 * beside the demo documents, and delete the whole case. The 24 h purge
 * (FR-7.3) bounds the duplication.
 *
 * Every table is copied with `INSERT ... SELECT` inside one transaction, so
 * the 1024-dimension embeddings never leave Postgres - which is the whole
 * reason this is SQL rather than TypeScript. Blobs are not copied at all: the
 * store is content-addressed, so the clone reuses the same `sha256`.
 *
 * New ids are minted rather than reused - each session's copy is genuinely its
 * own document, and a serialized clause id is scoped to its document id, so
 * citations resolve inside the clone exactly as they did in the template.
 * They are `gen_random_uuid()` (v4) rather than the uuidv7 the application
 * mints: nothing in the schema orders by id, and generating them in SQL is
 * what keeps this one transaction rather than a round trip per table.
 */
import { and, eq, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";

import { type Db } from "../db/client.js";
import { cases, documents } from "../db/schema/index.js";

export interface CloneParams {
  sourceCaseId: string;
  sourceTenantId: string;
  targetTenantId: string;
  title: string;
}

export interface CloneResult {
  caseId: string;
  documentCount: number;
}

export async function cloneCaseIntoTenant(db: Db, p: CloneParams): Promise<CloneResult> {
  return db.transaction(async (tx) => {
    const source = await tx
      .select({ retentionDays: cases.retentionDays })
      .from(cases)
      .where(and(eq(cases.id, p.sourceCaseId), eq(cases.tenantId, p.sourceTenantId)))
      .limit(1);
    if (!source[0]) throw new Error(`demo template case ${p.sourceCaseId} not found`);

    // `ON COMMIT DROP` is safe because a drizzle transaction pins one pooled
    // connection, and a temp table is scoped to exactly that.
    await tx.execute(sql`
      create temp table _clone_map (kind text not null, old uuid not null, new uuid not null)
      on commit drop
    `);
    await tx.execute(sql`create index on _clone_map (kind, old)`);

    const newCaseId = uuidv7();
    await tx.insert(cases).values({
      id: newCaseId,
      tenantId: p.targetTenantId,
      title: p.title,
      origin: "demo",
      retentionDays: source[0].retentionDays,
    });

    await tx.execute(sql`
      insert into _clone_map (kind, old, new)
      select 'document', id, gen_random_uuid()
      from documents
      where case_id = ${p.sourceCaseId}::uuid and tenant_id = ${p.sourceTenantId}::uuid
    `);

    await tx.execute(sql`
      insert into documents (id, case_id, tenant_id, sha256, filename, mime_type, byte_size,
                             page_count, language, type, status, parse_report, analysis_status)
      select m.new, ${newCaseId}::uuid, ${p.targetTenantId}::uuid, d.sha256, d.filename,
             d.mime_type, d.byte_size, d.page_count, d.language, d.type, d.status,
             d.parse_report, d.analysis_status
      from documents d
      join _clone_map m on m.kind = 'document' and m.old = d.id
    `);

    await tx.execute(sql`
      insert into _clone_map (kind, old, new)
      select 'clause', c.id, gen_random_uuid()
      from clauses c
      join _clone_map m on m.kind = 'document' and m.old = c.document_id
    `);

    await tx.execute(sql`
      insert into clauses (id, document_id, tenant_id, clause_ref, clause_path, heading,
                           heading_path, page, char_start, char_end, text, seq)
      select cm.new, dm.new, ${p.targetTenantId}::uuid, c.clause_ref, c.clause_path, c.heading,
             c.heading_path, c.page, c.char_start, c.char_end, c.text, c.seq
      from clauses c
      join _clone_map cm on cm.kind = 'clause' and cm.old = c.id
      join _clone_map dm on dm.kind = 'document' and dm.old = c.document_id
    `);

    await tx.execute(sql`
      insert into chunks (id, clause_id, document_id, case_id, tenant_id, chunk_index, text,
                          char_start, char_end, token_count, language, embedding, embedding_model)
      select gen_random_uuid(), cm.new, dm.new, ${newCaseId}::uuid, ${p.targetTenantId}::uuid,
             ch.chunk_index, ch.text, ch.char_start, ch.char_end, ch.token_count, ch.language,
             ch.embedding, ch.embedding_model
      from chunks ch
      join _clone_map cm on cm.kind = 'clause' and cm.old = ch.clause_id
      join _clone_map dm on dm.kind = 'document' and dm.old = ch.document_id
    `);

    await tx.execute(sql`
      insert into _clone_map (kind, old, new)
      select 'extraction', e.id, gen_random_uuid()
      from extractions e
      join _clone_map m on m.kind = 'document' and m.old = e.document_id
    `);

    await tx.execute(sql`
      insert into extractions (id, document_id, tenant_id, case_id, schema_ver, field_path,
                               value, unit, confidence, status)
      select em.new, dm.new, ${p.targetTenantId}::uuid, ${newCaseId}::uuid, e.schema_ver,
             e.field_path, e.value, e.unit, e.confidence, e.status
      from extractions e
      join _clone_map em on em.kind = 'extraction' and em.old = e.id
      join _clone_map dm on dm.kind = 'document' and dm.old = e.document_id
    `);

    // Extraction citations only: an answer citation belongs to a Q&A turn, and
    // turns are not cloned - the visitor's conversation starts empty.
    await tx.execute(sql`
      insert into citations (id, tenant_id, document_id, source_type, extraction_id, clause_id,
                             char_start, char_end, verbatim_anchor)
      select gen_random_uuid(), ${p.targetTenantId}::uuid, dm.new, ct.source_type, em.new, cm.new,
             ct.char_start, ct.char_end, ct.verbatim_anchor
      from citations ct
      join _clone_map dm on dm.kind = 'document' and dm.old = ct.document_id
      join _clone_map em on em.kind = 'extraction' and em.old = ct.extraction_id
      join _clone_map cm on cm.kind = 'clause' and cm.old = ct.clause_id
      where ct.source_type = 'extraction'
    `);

    // `clause_ids` is a uuid[], so every element is remapped, order preserved.
    await tx.execute(sql`
      insert into flags (id, document_id, tenant_id, case_id, rule_id, rule_version, severity,
                         clause_ids, rationale, negotiation_hint, sources)
      select gen_random_uuid(), dm.new, ${p.targetTenantId}::uuid, ${newCaseId}::uuid, f.rule_id,
             f.rule_version, f.severity,
             coalesce((
               select array_agg(cm.new order by u.ord)
               from unnest(f.clause_ids) with ordinality as u(old_id, ord)
               join _clone_map cm on cm.kind = 'clause' and cm.old = u.old_id
             ), '{}')::uuid[],
             f.rationale, f.negotiation_hint, f.sources
      from flags f
      join _clone_map dm on dm.kind = 'document' and dm.old = f.document_id
    `);

    const copied = await tx
      .select({ id: documents.id })
      .from(documents)
      .where(and(eq(documents.caseId, newCaseId), eq(documents.tenantId, p.targetTenantId)));

    return { caseId: newCaseId, documentCount: copied.length };
  });
}
