/**
 * The narrative report (FR-5.3): "agent writes narrative report (summary, terms
 * table, red flags ranked by severity, negotiation checklist, open questions) —
 * every line cited."
 *
 * A one-shot generation over the *already-computed* structured report, not a
 * second run of the agent loop. The report already knows every relevant clause:
 * each extracted field and each fired rule carries its citation rows. Making
 * the model rediscover them by search would cost turns and money, and would let
 * it miss a red flag the deterministic engine already found.
 *
 * **This extends ADR-0010 rather than bending it.** Point 4 says the citable
 * set is built from tool output, never model output. The general rule is
 * *server-controlled data*: tool output in the agent loop, persisted report
 * citations here. Either way the model cannot widen its own scope. Resolution
 * stays structural (ADR-0005) — `verbatimAnchor` is the clause's frozen text at
 * its frozen offsets — and `validateGrounding` / `buildCritique` are reused
 * unchanged, including the single corrective regeneration and `couldNotVerify`.
 *
 * The pre-seeded set is *stronger* grounding, not weaker: the narrative can
 * only cite clauses a deterministic pipeline already tied to a term or a rule,
 * so it cannot contradict the table it sits above.
 */
import { and, eq, inArray } from "drizzle-orm";

import { type NarrativeEvent, serializeClauseId } from "@contractix/shared";

import { type Db } from "../db/client.js";
import { clauses } from "../db/schema/index.js";
import { getCaseReport } from "../extraction/report-service.js";
import { type LlmMessage, type LlmProvider, type TokenUsage } from "../providers/index.js";
import {
  type AnswerCitation,
  buildCritique,
  type CitableClause,
  validateGrounding,
} from "./grounding.js";
import {
  buildReportUserMessage,
  REPORT_PROMPT_VERSION,
  REPORT_SYSTEM_PROMPT,
  type ReportInputClause,
  type ReportInputDocument,
} from "./report-prompt.js";

/**
 * Generous because `models.yaml` pins the agent role to `effort: high`, and on
 * an adaptive-thinking model this cap covers thinking *and* response text
 * together. A four-section report over a few dozen clauses at 4k produced
 * exactly zero characters: the entire budget went to reasoning.
 */
const MAX_TOKENS = 16_384;
const MAX_CORRECTIONS = 1;

/**
 * Declared as Zod in `@contractix/shared` (see `schemas/events.ts`) so the
 * writer and the web share one definition. Note `restart`: unlike `ask`, the
 * corrective regeneration IS streamed - a multi-paragraph report would
 * otherwise leave the reader staring at a frozen screen - so the client is told
 * to clear what it has rather than being left with two concatenated drafts.
 */
export type { NarrativeEvent };

export interface NarrativeDeps {
  db: Db;
  agentLlm: LlmProvider;
}

export interface NarrativeParams {
  caseId: string;
  tenantId: string;
  /** Scope the report to one document instead of the whole case. */
  documentId?: string;
  onEvent?: (event: NarrativeEvent) => void;
}

export interface NarrativeResult {
  markdown: string;
  citations: AnswerCitation[];
  couldNotVerify: string[];
  grounded: boolean;
  corrected: boolean;
  usage: TokenUsage;
  latencyMs: number;
  promptVersion: string;
  trace: {
    model: string;
    promptVersion: string;
    citableClauseIds: string[];
    corrections: { attempt: number; uncited: string[]; unresolvedMarkers: string[] }[];
    stopReason: string;
    inputFields: number;
    inputFlags: number;
    /** True when keyless mode short-circuited: no model call was made. */
    stubbed: boolean;
  };
}

/** Deterministic stand-in when there is nothing citable - see `writeNarrativeReport`. */
function stub(caseTitle: string, model: string, startedAt: number): NarrativeResult {
  const markdown = [
    "## Summary",
    "",
    `No analysed terms are available for ${caseTitle} yet, so there is nothing to narrate. [[caveat]]`,
    "",
    "## Red flags",
    "",
    "No red flags have been computed for this case. [[caveat]]",
    "",
    "## Negotiation checklist",
    "",
    "Run the analysis first; the checklist is derived from the extracted terms. [[caveat]]",
    "",
    "## Open questions",
    "",
    "Everything, until the documents have been analysed. [[caveat]]",
  ].join("\n");

  return {
    markdown,
    citations: [],
    couldNotVerify: [],
    grounded: true,
    corrected: false,
    usage: { inputTokens: 0, outputTokens: 0 },
    latencyMs: Date.now() - startedAt,
    promptVersion: REPORT_PROMPT_VERSION,
    trace: {
      model,
      promptVersion: REPORT_PROMPT_VERSION,
      citableClauseIds: [],
      corrections: [],
      stopReason: "stub",
      inputFields: 0,
      inputFlags: 0,
      stubbed: true,
    },
  };
}

/**
 * Every clause the structured report already cites - this is the citable set.
 * Loaded by id under the tenant guard, so a citation row pointing somewhere it
 * should not can never widen scope.
 */
async function loadCitableClauses(
  db: Db,
  tenantId: string,
  clauseIds: string[],
): Promise<{ citable: CitableClause[]; forPrompt: ReportInputClause[] }> {
  if (clauseIds.length === 0) return { citable: [], forPrompt: [] };
  const rows = await db
    .select({
      id: clauses.id,
      documentId: clauses.documentId,
      clauseRef: clauses.clauseRef,
      heading: clauses.heading,
      page: clauses.page,
      charStart: clauses.charStart,
      charEnd: clauses.charEnd,
      text: clauses.text,
    })
    .from(clauses)
    .where(and(eq(clauses.tenantId, tenantId), inArray(clauses.id, clauseIds)))
    .orderBy(clauses.documentId, clauses.seq);

  return {
    citable: rows.map((r) => ({
      clauseId: r.id,
      serializedClauseId: serializeClauseId(r.documentId, r.clauseRef),
      documentId: r.documentId,
      page: r.page,
      charStart: r.charStart,
      charEnd: r.charEnd,
      text: r.text,
    })),
    forPrompt: rows.map((r) => ({
      clauseId: r.id,
      serializedClauseId: serializeClauseId(r.documentId, r.clauseRef),
      clauseRef: r.clauseRef,
      page: r.page,
      heading: r.heading,
      text: r.text,
    })),
  };
}

export interface GenerateParams {
  caseTitle: string;
  documents: ReportInputDocument[];
  citable: CitableClause[];
  forPrompt: ReportInputClause[];
  onEvent?: (event: NarrativeEvent) => void;
}

/**
 * The model half: one generation, validated, with at most one corrective
 * regeneration. Separated from the loading half so the correction path can be
 * tested against a scripted provider without a database.
 */
export async function generateNarrative(
  deps: { agentLlm: LlmProvider },
  params: GenerateParams,
): Promise<NarrativeResult> {
  const startedAt = Date.now();
  const { caseTitle, documents, citable, forPrompt } = params;

  const fields = documents.flatMap((d) => d.fields);
  const flagList = documents.flatMap((d) => d.flags);

  // An empty citable set is exactly keyless mode, where FakeLlm reports every
  // field `not_found` and no rule fires. Calling a model with nothing to cite
  // could only produce an ungrounded answer, so short-circuit deterministically
  // and keep CI exercising the real path everywhere else.
  if (citable.length === 0) return stub(caseTitle, deps.agentLlm.id, startedAt);

  const userMessage = buildReportUserMessage(caseTitle, documents, forPrompt);
  return runGeneration(
    deps,
    params,
    userMessage,
    citable,
    fields.length,
    flagList.length,
    startedAt,
  );
}

async function runGeneration(
  deps: { agentLlm: LlmProvider },
  params: { onEvent?: (event: NarrativeEvent) => void },
  userMessage: string,
  citable: CitableClause[],
  inputFields: number,
  inputFlags: number,
  startedAt: number,
): Promise<NarrativeResult> {
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  const corrections: NarrativeResult["trace"]["corrections"] = [];
  let markdown = "";
  let grounding = validateGrounding("", []);
  let stopReason = "end_turn";
  let attempt = 0;

  let messages: LlmMessage[] = [{ role: "user", content: [{ type: "text", text: userMessage }] }];

  for (;;) {
    attempt++;
    const res = await deps.agentLlm.converse({
      system: REPORT_SYSTEM_PROMPT,
      messages,
      tools: [],
      maxTokens: MAX_TOKENS,
      ...(params.onEvent
        ? { onTextDelta: (text: string) => params.onEvent?.({ type: "token", text }) }
        : {}),
    });

    usage.inputTokens += res.usage.inputTokens;
    usage.outputTokens += res.usage.outputTokens;
    stopReason = res.stopReason;

    markdown = res.content
      .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("");

    // An empty or truncated report must never read as success. `validateGrounding`
    // says an empty string is fine - it contains no uncited assertion - which is
    // true and useless: a report that ends mid-sentence can also end mid-citation.
    // Retrying buys nothing, since the same budget truncates the same way.
    if (markdown.trim().length === 0) {
      throw new Error(
        `narrative generation produced no text (stopReason: ${res.stopReason}); ` +
          "the token budget is likely exhausted by reasoning",
      );
    }
    if (res.stopReason === "max_tokens") {
      throw new Error("narrative generation hit the token ceiling and would be truncated");
    }

    grounding = validateGrounding(markdown, citable);
    if (grounding.ok || attempt > MAX_CORRECTIONS) break;

    corrections.push({
      attempt,
      uncited: grounding.uncited,
      unresolvedMarkers: grounding.unresolvedMarkers,
    });
    params.onEvent?.({ type: "retry", reason: buildCritique(grounding, citable).slice(0, 200) });
    params.onEvent?.({ type: "restart" });

    messages = [
      ...messages,
      { role: "assistant", content: [{ type: "text", text: markdown }] },
      { role: "user", content: [{ type: "text", text: buildCritique(grounding, citable) }] },
    ];
  }

  return {
    markdown,
    citations: grounding.citations,
    couldNotVerify: grounding.uncited,
    grounded: grounding.ok,
    corrected: corrections.length > 0,
    usage,
    latencyMs: Date.now() - startedAt,
    promptVersion: REPORT_PROMPT_VERSION,
    trace: {
      model: deps.agentLlm.id,
      promptVersion: REPORT_PROMPT_VERSION,
      citableClauseIds: citable.map((c) => c.clauseId),
      corrections,
      stopReason,
      inputFields,
      inputFlags,
      stubbed: false,
    },
  };
}

/**
 * The loading half: read the structured report, collect the clauses it already
 * cites, and hand both to the model. Tenant-scoped throughout — the citable set
 * is loaded under the same `tenant_id` guard as everything else, so a citation
 * row cannot widen scope even if one were wrong.
 */
export async function writeNarrativeReport(
  deps: NarrativeDeps,
  params: NarrativeParams,
): Promise<NarrativeResult> {
  const report = await getCaseReport(
    { db: deps.db },
    { caseId: params.caseId, tenantId: params.tenantId },
  );
  if (!report) throw new Error(`case ${params.caseId} not found for tenant`);

  const scoped = params.documentId
    ? report.documents.filter((d) => d.document.id === params.documentId)
    : report.documents;

  const documents: ReportInputDocument[] = scoped.map((d) => ({
    documentId: d.document.id,
    filename: d.document.filename,
    type: d.document.type,
    language: d.document.language,
    fields: d.extraction?.fields ?? [],
    flags: d.flags,
  }));

  const clauseIds = [
    ...new Set(
      documents
        .flatMap((d) => [...d.fields, ...d.flags])
        .flatMap((x) => x.citations.map((c) => c.clauseId)),
    ),
  ];
  const { citable, forPrompt } = await loadCitableClauses(deps.db, params.tenantId, clauseIds);

  return generateNarrative(deps, {
    caseTitle: report.case.title,
    documents,
    citable,
    forPrompt,
    ...(params.onEvent ? { onEvent: params.onEvent } : {}),
  });
}
