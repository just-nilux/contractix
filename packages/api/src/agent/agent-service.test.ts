import { describe, expect, it } from "vitest";

import { type Db } from "../db/client.js";
import {
  type LlmConverseOptions,
  type LlmConverseResult,
  type LlmExtractResult,
  type LlmProvider,
} from "../providers/index.js";
import { type ClauseView } from "../retrieval/clause-service.js";
import { type AgentEvent, askCase, MAX_TURNS } from "./agent-service.js";
import { type AgentTool } from "./tools/index.js";

const DOC = "6a2f1c3e-4b5d-4e6f-8a9b-0c1d2e3f4a5b";
const CLAUSE_ID = `${DOC}:2:§3`;

const CLAUSE: ClauseView = {
  id: "11111111-2222-4333-8444-555555555555",
  documentId: DOC,
  clauseRef: "2:§3",
  serializedClauseId: CLAUSE_ID,
  clausePath: "§3",
  heading: "Probezeit",
  headingPath: ["Probezeit"],
  page: 2,
  charStart: 100,
  charEnd: 134,
  seq: 4,
  text: "Die Probezeit beträgt sechs Monate.",
};

/** A search tool that needs no database — the loop is what's under test. */
const fakeSearch: AgentTool = {
  name: "search_clauses",
  description: "search",
  jsonSchema: { type: "object" },
  execute: () => Promise.resolve({ result: [{ clause_id: CLAUSE_ID }], clauses: [CLAUSE] }),
};

const explodingTool: AgentTool = {
  name: "search_clauses",
  description: "search",
  jsonSchema: { type: "object" },
  execute: () => Promise.reject(new Error("postgres is down")),
};

/** Replays a fixed sequence of model turns, recording what it was sent. */
class ScriptedLlm implements LlmProvider {
  readonly id = "stub:agent";
  readonly seen: LlmConverseOptions[] = [];
  private turn = 0;

  constructor(private readonly script: LlmConverseResult[]) {}

  extract(): Promise<LlmExtractResult> {
    throw new Error("not used");
  }

  converse(opts: LlmConverseOptions): Promise<LlmConverseResult> {
    // Snapshot: the loop mutates one messages array in place, so storing the
    // reference would make every assertion read the final state instead.
    this.seen.push({ ...opts, messages: structuredClone(opts.messages) });
    const next = this.script[this.turn++] ?? this.script.at(-1)!;
    if (opts.onTextDelta) {
      for (const b of next.content) if (b.type === "text") opts.onTextDelta(b.text);
    }
    return Promise.resolve(next);
  }
}

const usage = { inputTokens: 10, outputTokens: 5 };

const answer = (text: string): LlmConverseResult => ({
  stopReason: "end_turn",
  content: [{ type: "text", text }],
  usage,
});

const callSearch = (id = "tu_1"): LlmConverseResult => ({
  stopReason: "tool_use",
  content: [{ type: "tool_use", id, name: "search_clauses", input: { query: "Probezeit" } }],
  usage,
});

function deps(llm: LlmProvider, tools: readonly AgentTool[] = [fakeSearch]) {
  return {
    db: null as unknown as Db,
    embeddings: null as never,
    reranker: null as never,
    agentLlm: llm,
    tools,
  };
}

const ask = (llm: LlmProvider, tools?: readonly AgentTool[], onEvent?: (e: AgentEvent) => void) =>
  askCase(deps(llm, tools), {
    caseId: "case-1",
    tenantId: "tenant-1",
    question: "Wie lang ist die Probezeit?",
    ...(onEvent ? { onEvent } : {}),
  });

describe("askCase", () => {
  it("retrieves, then answers citing what the tool surfaced", async () => {
    const llm = new ScriptedLlm([
      callSearch(),
      answer(`Die Probezeit beträgt sechs Monate [[${CLAUSE_ID}]].`),
    ]);
    const res = await ask(llm);

    expect(res.grounded).toBe(true);
    expect(res.corrected).toBe(false);
    expect(res.couldNotVerify).toEqual([]);
    expect(res.citations).toHaveLength(1);
    expect(res.citations[0]?.charStart).toBe(CLAUSE.charStart);
    expect(res.citations[0]?.verbatimAnchor).toBe(CLAUSE.text);
    expect(res.trace.turns).toBe(2);
    expect(res.trace.steps.map((s) => s.tool)).toEqual(["search_clauses"]);
    expect(res.usage).toEqual({ inputTokens: 20, outputTokens: 10 });
  });

  it("returns every tool result for one turn in a single user message", async () => {
    const twoCalls: LlmConverseResult = {
      stopReason: "tool_use",
      content: [
        { type: "tool_use", id: "a", name: "search_clauses", input: { query: "x" } },
        { type: "tool_use", id: "b", name: "search_clauses", input: { query: "y" } },
      ],
      usage,
    };
    const llm = new ScriptedLlm([twoCalls, answer(`Sechs Monate [[${CLAUSE_ID}]].`)]);
    await ask(llm);

    // Splitting parallel results across messages trains the model out of
    // parallel tool use, so this shape is load-bearing.
    const second = llm.seen[1]!.messages;
    const resultMsg = second.at(-1)!;
    expect(resultMsg.role).toBe("user");
    expect(resultMsg.content).toHaveLength(2);
    expect(resultMsg.content.every((b) => b.type === "tool_result")).toBe(true);
  });

  it("runs exactly one corrective regeneration when the answer is ungrounded", async () => {
    const llm = new ScriptedLlm([
      callSearch(),
      answer("Die Probezeit beträgt drei Monate."), // no citation
      answer(`Die Probezeit beträgt sechs Monate [[${CLAUSE_ID}]].`),
    ]);
    const events: AgentEvent[] = [];
    const res = await ask(llm, [fakeSearch], (e) => events.push(e));

    expect(res.grounded).toBe(true);
    expect(res.corrected).toBe(true);
    expect(events.filter((e) => e.type === "retry")).toHaveLength(1);

    const critique = llm.seen[2]!.messages.at(-1)!.content[0];
    expect(critique?.type).toBe("text");
    expect(critique?.type === "text" && critique.text).toContain(
      "Die Probezeit beträgt drei Monate.",
    );
  });

  it("surfaces unverifiable claims instead of dropping them after the retry", async () => {
    const llm = new ScriptedLlm([
      callSearch(),
      answer("Die Probezeit beträgt drei Monate."),
      answer("Die Probezeit beträgt drei Monate."), // still ungrounded
    ]);
    const res = await ask(llm);

    expect(res.grounded).toBe(false);
    expect(res.corrected).toBe(true);
    expect(res.couldNotVerify).toEqual(["Die Probezeit beträgt drei Monate."]);
    // FR-5.2: returned with the caveat, never silently discarded.
    expect(res.answer).toContain("drei Monate");
  });

  it("rejects a citation naming a clause no tool returned", async () => {
    const invented = `${DOC}:9:§99`;
    const llm = new ScriptedLlm([
      callSearch(),
      answer(`Es gilt eine Sperrfrist [[${invented}]].`),
      answer(`Es gilt eine Sperrfrist [[${invented}]].`),
    ]);
    const res = await ask(llm);

    expect(res.grounded).toBe(false);
    expect(res.citations).toEqual([]);
    expect(res.couldNotVerify).toHaveLength(1);
  });

  it("reports a tool failure to the model rather than throwing", async () => {
    const llm = new ScriptedLlm([callSearch(), answer("Die Dokumente enthalten dazu nichts.")]);
    const res = await ask(llm, [explodingTool]);

    // The turn completes; the model just has nothing to cite.
    expect(res.trace.steps[0]?.ok).toBe(false);
    const sent = llm.seen[1]!.messages.at(-1)!.content[0];
    expect(sent?.type === "tool_result" && sent.isError).toBe(true);
    expect(sent?.type === "tool_result" && sent.content).toContain("postgres is down");
  });

  it("answers a tool call for a name it does not know", async () => {
    const unknown: LlmConverseResult = {
      stopReason: "tool_use",
      content: [{ type: "tool_use", id: "u", name: "delete_everything", input: {} }],
      usage,
    };
    const llm = new ScriptedLlm([unknown, answer("Nichts gefunden.")]);
    const res = await ask(llm);

    const sent = llm.seen[1]!.messages.at(-1)!.content[0];
    expect(sent?.type === "tool_result" && sent.content).toContain("unknown tool");
    expect(res.trace.steps[0]?.ok).toBe(false);
  });

  it("stops at the turn ceiling when the model never stops calling tools", async () => {
    const llm = new ScriptedLlm([callSearch()]);
    const res = await ask(llm);

    expect(res.trace.turns).toBe(MAX_TURNS);
    expect(res.trace.stopReason).toBe("turn_limit");
    expect(res.answer).toBe("");
  });

  it("streams the answer once, not the discarded first attempt", async () => {
    const llm = new ScriptedLlm([
      answer("Die Probezeit beträgt drei Monate."),
      answer(`Sechs Monate [[${CLAUSE_ID}]].`),
    ]);
    const events: AgentEvent[] = [];
    await ask(llm, [fakeSearch], (e) => events.push(e));

    const streamed = events
      .filter((e): e is Extract<AgentEvent, { type: "token" }> => e.type === "token")
      .map((e) => e.text)
      .join("");
    expect(streamed).toBe("Die Probezeit beträgt drei Monate.");
  });

  it("keeps the cached system prompt and tool order byte-stable across turns", async () => {
    const llm = new ScriptedLlm([callSearch(), answer(`Sechs Monate [[${CLAUSE_ID}]].`)]);
    await ask(llm);

    expect(llm.seen[0]!.system).toBe(llm.seen[1]!.system);
    expect(llm.seen[0]!.tools.map((t) => t.name)).toEqual(llm.seen[1]!.tools.map((t) => t.name));
  });
});
