import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { type Db } from "../../db/client.js";
import { citations, documents, extractions, flags } from "../../db/schema/index.js";
import {
  type EmbeddingsProvider,
  type JsonSchema,
  type RerankerProvider,
} from "../../providers/index.js";
import {
  type ClauseView,
  getClause,
  getClauseContext,
  getClausesByIds,
  getClausesBySerializedId,
} from "../../retrieval/clause-service.js";
import { searchClauses } from "../../retrieval/search-service.js";
import { evaluateArithmetic } from "./arithmetic.js";

/**
 * Everything a tool may touch. `tenantId` and `caseId` come from the HTTP
 * request, never from model output — that is the FR-7.4 guard, and it is why no
 * tool takes a tenant or case parameter: the model cannot widen its own scope.
 */
export interface ToolContext {
  db: Db;
  embeddings: EmbeddingsProvider;
  reranker: RerankerProvider;
  tenantId: string;
  caseId: string;
}

export interface ToolOutcome {
  /** JSON-serializable payload handed back to the model. */
  result: unknown;
  /**
   * Clauses this call put in front of the model. The union across a request is
   * the citable set: the grounding validator rejects a `[[clause_id]]` marker
   * naming anything a tool did not actually surface.
   */
  clauses?: ClauseView[];
}

export interface AgentTool {
  name: string;
  description: string;
  jsonSchema: JsonSchema;
  execute(rawInput: unknown, ctx: ToolContext): Promise<ToolOutcome>;
}

function defineTool<S extends z.ZodType>(spec: {
  name: string;
  description: string;
  schema: S;
  run: (input: z.infer<S>, ctx: ToolContext) => Promise<ToolOutcome>;
}): AgentTool {
  return {
    name: spec.name,
    description: spec.description,
    jsonSchema: z.toJSONSchema(spec.schema),
    async execute(rawInput, ctx) {
      const parsed = spec.schema.safeParse(rawInput ?? {});
      if (!parsed.success) {
        // Reported back as a tool_result so the model can correct itself,
        // rather than thrown — a bad argument is not a server error.
        return { result: { error: "invalid tool input", issues: parsed.error.issues } };
      }
      return spec.run(parsed.data, ctx);
    },
  };
}

const searchTool = defineTool({
  name: "search_clauses",
  description:
    "Hybrid search over the clauses of this case. Returns the best-matching clauses with " +
    "their citation ids. Use this first for any question about what a document says.",
  schema: z.object({
    query: z.string().min(1).describe("Natural-language query, in the document's language."),
    document_id: z.uuid().optional().describe("Restrict the search to one document."),
    top_k: z.number().int().min(1).max(20).default(8),
  }),
  async run(input, ctx) {
    const results = await searchClauses(ctx, {
      tenantId: ctx.tenantId,
      caseId: ctx.caseId,
      documentId: input.document_id,
      query: input.query,
      topK: input.top_k,
    });
    // Snippets are truncated for the model, so load the full clause rows for
    // the citable set — the validator slices frozen text, never a snippet.
    const clauses = await getClausesByIds(ctx, {
      clauseIds: results.map((r) => r.clauseId),
      tenantId: ctx.tenantId,
    });
    return {
      result: results.map((r) => ({
        clause_id: r.serializedClauseId,
        document_id: r.documentId,
        page: r.page,
        heading: r.heading,
        snippet: r.snippet,
      })),
      clauses,
    };
  },
});

const getClauseTool = defineTool({
  name: "get_clause",
  description: "Fetch the full text of one clause by its citation id.",
  schema: z.object({ clause_id: z.string().min(1) }),
  async run(input, ctx) {
    const clause = await resolveClause(ctx, input.clause_id);
    if (!clause) return { result: { error: "clause not found", clause_id: input.clause_id } };
    return { result: asToolClause(clause), clauses: [clause] };
  },
});

const getClauseContextTool = defineTool({
  name: "get_clause_context",
  description:
    "Fetch a clause together with its neighbouring clauses, for when a term is defined or " +
    "qualified nearby.",
  schema: z.object({
    clause_id: z.string().min(1),
    radius: z.number().int().min(1).max(5).default(1),
  }),
  async run(input, ctx) {
    const clause = await resolveClause(ctx, input.clause_id);
    if (!clause) return { result: { error: "clause not found", clause_id: input.clause_id } };
    const ctxResult = await getClauseContext(ctx, {
      clauseId: clause.id,
      tenantId: ctx.tenantId,
      radius: input.radius,
    });
    if (!ctxResult) return { result: { error: "clause not found", clause_id: input.clause_id } };
    const all = [...ctxResult.before, ctxResult.clause, ...ctxResult.after];
    return { result: all.map(asToolClause), clauses: all };
  },
});

const getExtractionTool = defineTool({
  name: "get_extraction",
  description:
    "Read the structured terms already extracted from a document (salary, vesting, " +
    "liquidation preference, ...), each with the clause it came from.",
  schema: z.object({
    document_id: z.uuid(),
    field_path: z.string().min(1).optional().describe("Restrict to a single field."),
  }),
  async run(input, ctx) {
    const owned = await ownedDocumentIds(ctx, [input.document_id]);
    if (owned.length === 0) return { result: { error: "document not found in this case" } };

    const rows = await ctx.db
      .select({
        id: extractions.id,
        fieldPath: extractions.fieldPath,
        value: extractions.value,
        unit: extractions.unit,
        confidence: extractions.confidence,
        status: extractions.status,
      })
      .from(extractions)
      .where(
        and(eq(extractions.documentId, input.document_id), eq(extractions.tenantId, ctx.tenantId)),
      );

    const wanted = input.field_path ? rows.filter((r) => r.fieldPath === input.field_path) : rows;
    const { byExtraction, clauses } = await citationsFor(
      ctx,
      wanted.map((r) => r.id),
      input.document_id,
    );

    return {
      result: wanted.map((r) => ({
        field_path: r.fieldPath,
        value: r.value,
        unit: r.unit,
        confidence: r.confidence,
        status: r.status,
        clause_ids: byExtraction.get(r.id) ?? [],
      })),
      clauses,
    };
  },
});

const runBenchmarkTool = defineTool({
  name: "run_benchmark",
  description:
    "Read the deterministic red-flag findings already computed for a document, with severity, " +
    "rationale and the clauses that triggered each rule.",
  schema: z.object({ document_id: z.uuid() }),
  async run(input, ctx) {
    const owned = await ownedDocumentIds(ctx, [input.document_id]);
    if (owned.length === 0) return { result: { error: "document not found in this case" } };

    // Read the persisted rows; re-running the rules engine mid-loop could
    // disagree with the report the user is looking at.
    const rows = await ctx.db
      .select({
        ruleId: flags.ruleId,
        severity: flags.severity,
        rationale: flags.rationale,
        negotiationHint: flags.negotiationHint,
        sources: flags.sources,
        clauseIds: flags.clauseIds,
      })
      .from(flags)
      .where(and(eq(flags.documentId, input.document_id), eq(flags.tenantId, ctx.tenantId)));

    const clauses = await getClausesByIds(ctx, {
      clauseIds: rows.flatMap((r) => r.clauseIds),
      tenantId: ctx.tenantId,
    });
    const byId = new Map(clauses.map((c) => [c.id, c.serializedClauseId]));

    return {
      result: rows.map((r) => ({
        rule_id: r.ruleId,
        severity: r.severity,
        rationale: r.rationale,
        negotiation_hint: r.negotiationHint,
        sources: r.sources ?? [],
        clause_ids: r.clauseIds.map((id) => byId.get(id)).filter(Boolean),
      })),
      clauses,
    };
  },
});

const compareDocumentsTool = defineTool({
  name: "compare_documents",
  description:
    "Compare one extracted field across several documents in this case, for side-by-side " +
    "questions about competing offers.",
  schema: z.object({
    field_path: z.string().min(1),
    document_ids: z.array(z.uuid()).min(2).max(4),
  }),
  async run(input, ctx) {
    const owned = await ownedDocumentIds(ctx, input.document_ids);
    if (owned.length === 0) return { result: { error: "no such documents in this case" } };

    const rows = await ctx.db
      .select({
        id: extractions.id,
        documentId: extractions.documentId,
        fieldPath: extractions.fieldPath,
        value: extractions.value,
        unit: extractions.unit,
        confidence: extractions.confidence,
        status: extractions.status,
      })
      .from(extractions)
      .where(
        and(
          eq(extractions.tenantId, ctx.tenantId),
          inArray(extractions.documentId, owned),
          eq(extractions.fieldPath, input.field_path),
        ),
      );

    const { byExtraction, clauses } = await citationsFor(
      ctx,
      rows.map((r) => r.id),
    );

    return {
      result: {
        field_path: input.field_path,
        // Documents with no row for this field are reported explicitly rather
        // than omitted, so "absent" never reads as "not compared".
        documents: owned.map((documentId) => {
          const row = rows.find((r) => r.documentId === documentId);
          return row
            ? {
                document_id: documentId,
                value: row.value,
                unit: row.unit,
                confidence: row.confidence,
                status: row.status,
                clause_ids: byExtraction.get(row.id) ?? [],
              }
            : { document_id: documentId, status: "not_extracted" };
        }),
      },
      clauses,
    };
  },
});

const mathTool = defineTool({
  name: "math",
  description:
    "Evaluate an arithmetic expression (+ - * / ^, parentheses). Use this for every dilution, " +
    "vesting or percentage calculation instead of computing in your head.",
  schema: z.object({
    expression: z.string().min(1).describe("e.g. '1000000 / (1000000 + 250000) * 100'"),
  }),
  run(input) {
    return Promise.resolve({ result: evaluateArithmetic(input.expression) });
  },
});

/**
 * Accepts either a serialized citation id (`{documentId}:{page}:{path}`, the
 * form the model sees) or a raw clause uuid. Always re-checks that the clause's
 * document is in *this* case, so a clause id lifted from another case's answer
 * resolves to nothing.
 */
async function resolveClause(ctx: ToolContext, id: string): Promise<ClauseView | null> {
  const clause = id.includes(":")
    ? ((
        await getClausesBySerializedId(ctx, {
          serializedIds: [id],
          tenantId: ctx.tenantId,
        })
      ).get(id) ?? null)
    : await getClause(ctx, { clauseId: id, tenantId: ctx.tenantId });

  if (!clause) return null;
  const owned = await ownedDocumentIds(ctx, [clause.documentId]);
  return owned.length > 0 ? clause : null;
}

function asToolClause(c: ClauseView) {
  return {
    clause_id: c.serializedClauseId,
    document_id: c.documentId,
    page: c.page,
    heading: c.heading,
    text: c.text,
  };
}

/** Case-scoped document filter — the tool-level half of the tenant guard. */
async function ownedDocumentIds(ctx: ToolContext, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await ctx.db
    .select({ id: documents.id })
    .from(documents)
    .where(
      and(
        eq(documents.tenantId, ctx.tenantId),
        eq(documents.caseId, ctx.caseId),
        inArray(documents.id, [...new Set(ids)]),
      ),
    );
  const found = new Set(rows.map((r) => r.id));
  return ids.filter((id) => found.has(id));
}

/** Extraction citations, as serialized clause ids plus the citable clause rows. */
async function citationsFor(
  ctx: ToolContext,
  extractionIds: string[],
  documentId?: string,
): Promise<{ byExtraction: Map<string, string[]>; clauses: ClauseView[] }> {
  const byExtraction = new Map<string, string[]>();
  if (extractionIds.length === 0) return { byExtraction, clauses: [] };

  const rows = await ctx.db
    .select({ extractionId: citations.extractionId, clauseId: citations.clauseId })
    .from(citations)
    .where(
      and(
        eq(citations.tenantId, ctx.tenantId),
        eq(citations.sourceType, "extraction"),
        inArray(citations.extractionId, extractionIds),
        ...(documentId ? [eq(citations.documentId, documentId)] : []),
      ),
    );

  const clauses = await getClausesByIds(ctx, {
    clauseIds: rows.map((r) => r.clauseId),
    tenantId: ctx.tenantId,
  });
  const byId = new Map(clauses.map((c) => [c.id, c.serializedClauseId]));

  for (const row of rows) {
    if (!row.extractionId) continue;
    const serialized = byId.get(row.clauseId);
    if (!serialized) continue;
    const list = byExtraction.get(row.extractionId) ?? [];
    list.push(serialized);
    byExtraction.set(row.extractionId, list);
  }
  return { byExtraction, clauses };
}

/**
 * The agent's tool surface (FR-5.1), in a fixed order — the tool list is part
 * of the cached prompt prefix, so reordering it would invalidate the cache on
 * every turn.
 */
export const AGENT_TOOLS: readonly AgentTool[] = Object.freeze([
  searchTool,
  getClauseTool,
  getClauseContextTool,
  getExtractionTool,
  runBenchmarkTool,
  compareDocumentsTool,
  mathTool,
]);

export const AGENT_TOOLS_BY_NAME: ReadonlyMap<string, AgentTool> = new Map(
  AGENT_TOOLS.map((t) => [t.name, t]),
);
