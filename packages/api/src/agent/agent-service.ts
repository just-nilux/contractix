import { type Db } from "../db/client.js";
import {
  type LlmContentBlock,
  type LlmMessage,
  type LlmProvider,
  type TokenUsage,
} from "../providers/index.js";
import { type ClauseView } from "../retrieval/clause-service.js";
import {
  type AnswerCitation,
  buildCritique,
  type CitableClause,
  type GroundingResult,
  validateGrounding,
} from "./grounding.js";
import { SYSTEM_PROMPT } from "./prompt.js";
import { AGENT_TOOLS, type AgentTool, type ToolContext } from "./tools/index.js";

/** FR-5.1: hard ceilings, so one question can never run away. */
export const MAX_TURNS = 12;
export const MAX_OUTPUT_TOKENS_PER_REQUEST = 60_000;
const MAX_TOKENS_PER_TURN = 8_192;
/** FR-5.2 allows exactly one corrective regeneration. */
const MAX_CORRECTIONS = 1;

export interface AgentDeps extends Omit<ToolContext, "tenantId" | "caseId"> {
  db: Db;
  agentLlm: LlmProvider;
  /** Defaults to AGENT_TOOLS; overridden in tests to run the loop without a DB. */
  tools?: readonly AgentTool[];
}

export interface AskParams {
  caseId: string;
  tenantId: string;
  question: string;
  onEvent?: (event: AgentEvent) => void;
}

export type AgentEvent =
  | { type: "token"; text: string }
  | { type: "tool_call"; name: string; input: unknown }
  | { type: "tool_result"; name: string; ok: boolean; clauseCount: number }
  | { type: "retry"; reason: string };

export interface TraceStep {
  turn: number;
  tool: string;
  input: unknown;
  ok: boolean;
  clauseCount: number;
  durationMs: number;
}

export interface AskResult {
  answer: string;
  citations: AnswerCitation[];
  /** Assertions the validator could not tie to a clause (FR-5.2). */
  couldNotVerify: string[];
  grounded: boolean;
  corrected: boolean;
  usage: TokenUsage;
  latencyMs: number;
  trace: {
    model: string;
    turns: number;
    steps: TraceStep[];
    citableClauseIds: string[];
    stopReason: string;
  };
}

function textOf(blocks: LlmContentBlock[]): string {
  return blocks
    .filter((b): b is Extract<LlmContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("");
}

function toCitable(clause: ClauseView): CitableClause {
  return {
    clauseId: clause.id,
    serializedClauseId: clause.serializedClauseId,
    documentId: clause.documentId,
    page: clause.page,
    charStart: clause.charStart,
    charEnd: clause.charEnd,
    text: clause.text,
  };
}

/**
 * The agentic Q&A loop (FR-5.1, FR-5.2, FR-5.5).
 *
 * Hand-rolled rather than delegated to a framework (PRD §8) because the
 * grounding contract, the turn/token budget and the trace are the product —
 * they need to be inspectable, not buried in a library's control flow.
 *
 * Shape: converse -> execute every requested tool -> feed all results back in
 * one user message -> repeat until the model stops asking for tools. The
 * answer is then validated structurally; a failure buys exactly one corrective
 * regeneration, after which the unsupported claims are returned in
 * `couldNotVerify` rather than silently dropped.
 */
export async function askCase(deps: AgentDeps, params: AskParams): Promise<AskResult> {
  const startedAt = Date.now();
  const toolCtx: ToolContext = {
    db: deps.db,
    embeddings: deps.embeddings,
    reranker: deps.reranker,
    tenantId: params.tenantId,
    caseId: params.caseId,
  };

  const tools = deps.tools ?? AGENT_TOOLS;
  const toolsByName = new Map(tools.map((t) => [t.name, t]));
  const toolDefs = tools.map((t) => ({
    name: t.name,
    description: t.description,
    jsonSchema: t.jsonSchema,
  }));

  const messages: LlmMessage[] = [
    { role: "user", content: [{ type: "text", text: params.question }] },
  ];
  // Accumulated across the whole request, including the CRAG retry: a clause
  // stays citable once a tool has surfaced it.
  const citable = new Map<string, CitableClause>();
  const steps: TraceStep[] = [];
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

  let turns = 0;
  let corrections = 0;
  let stopReason = "end_turn";
  let answer = "";
  let grounding: GroundingResult = validateGrounding("", []);

  while (turns < MAX_TURNS) {
    turns++;

    // Only stream tokens on a turn that can actually be the answer; a
    // corrective regeneration would otherwise emit a second answer to the UI.
    const streaming = params.onEvent && corrections === 0;
    const res = await deps.agentLlm.converse({
      system: SYSTEM_PROMPT,
      messages,
      tools: toolDefs,
      maxTokens: MAX_TOKENS_PER_TURN,
      ...(streaming
        ? { onTextDelta: (text: string) => params.onEvent?.({ type: "token", text }) }
        : {}),
    });

    usage.inputTokens += res.usage.inputTokens;
    usage.outputTokens += res.usage.outputTokens;
    stopReason = res.stopReason;

    const toolUses = res.content.filter(
      (b): b is Extract<LlmContentBlock, { type: "tool_use" }> => b.type === "tool_use",
    );

    if (toolUses.length > 0) {
      messages.push({ role: "assistant", content: res.content });

      const results: LlmContentBlock[] = [];
      for (const call of toolUses) {
        params.onEvent?.({ type: "tool_call", name: call.name, input: call.input });
        const tool = toolsByName.get(call.name);
        const at = Date.now();

        if (!tool) {
          results.push({
            type: "tool_result",
            toolUseId: call.id,
            content: JSON.stringify({ error: `unknown tool '${call.name}'` }),
            isError: true,
          });
          steps.push({
            turn: turns,
            tool: call.name,
            input: call.input,
            ok: false,
            clauseCount: 0,
            durationMs: Date.now() - at,
          });
          continue;
        }

        let outcome;
        let ok = true;
        try {
          outcome = await tool.execute(call.input, toolCtx);
        } catch (err) {
          // A tool failure is reported to the model, not to the user as a 500 —
          // it can retry with different arguments or answer without that tool.
          ok = false;
          outcome = { result: { error: err instanceof Error ? err.message : String(err) } };
        }

        for (const clause of outcome.clauses ?? []) {
          citable.set(clause.serializedClauseId, toCitable(clause));
        }

        results.push({
          type: "tool_result",
          toolUseId: call.id,
          content: JSON.stringify(outcome.result),
          ...(ok ? {} : { isError: true }),
        });
        steps.push({
          turn: turns,
          tool: call.name,
          input: call.input,
          ok,
          clauseCount: outcome.clauses?.length ?? 0,
          durationMs: Date.now() - at,
        });
        params.onEvent?.({
          type: "tool_result",
          name: call.name,
          ok,
          clauseCount: outcome.clauses?.length ?? 0,
        });
      }

      // All results for one assistant turn go back in a SINGLE user message —
      // splitting them trains the model out of parallel tool use.
      messages.push({ role: "user", content: results });

      if (usage.outputTokens >= MAX_OUTPUT_TOKENS_PER_REQUEST) {
        stopReason = "budget_exhausted";
        break;
      }
      continue;
    }

    answer = textOf(res.content);
    grounding = validateGrounding(answer, [...citable.values()]);

    if (grounding.ok || corrections >= MAX_CORRECTIONS || res.stopReason === "refusal") break;

    // CRAG: critique -> regenerate, exactly once.
    corrections++;
    params.onEvent?.({
      type: "retry",
      reason:
        grounding.uncited.length > 0 ? "uncited claims" : "citations naming unretrieved clauses",
    });
    messages.push({ role: "assistant", content: res.content });
    messages.push({
      role: "user",
      content: [{ type: "text", text: buildCritique(grounding, [...citable.values()]) }],
    });
  }

  if (turns >= MAX_TURNS && stopReason === "tool_use") stopReason = "turn_limit";

  return {
    answer,
    citations: grounding.citations,
    couldNotVerify: grounding.uncited,
    grounded: grounding.ok,
    corrected: corrections > 0,
    usage,
    latencyMs: Date.now() - startedAt,
    trace: {
      model: deps.agentLlm.id,
      turns,
      steps,
      citableClauseIds: [...citable.keys()],
      stopReason,
    },
  };
}
