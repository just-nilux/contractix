import { describe, expect, it } from "vitest";

import { narrativeTraceSchema } from "@contractix/shared";

import {
  type LlmConverseOptions,
  type LlmConverseResult,
  type LlmExtractOptions,
  type LlmExtractResult,
  type LlmProvider,
} from "../providers/index.js";
import { type CitableClause } from "./grounding.js";
import { generateNarrative, type NarrativeEvent } from "./report-writer.js";
import { type ReportInputClause, type ReportInputDocument } from "./report-prompt.js";

const CLAUSE_ID = "0198f4d2-0000-7000-8000-00000000000a";
/**
 * What the model actually writes. Markers resolve against the *serialized*
 * clause id ({documentId}:{clauseRef}, ADR-0005), not the row uuid - the same
 * form the agent loop's tools surface.
 */
const DOC_ID = "0198f4d2-0000-7000-8000-0000000000d1";
const MARKER = `${DOC_ID}:1:1`;

const CITABLE: CitableClause[] = [
  {
    clauseId: CLAUSE_ID,
    serializedClauseId: MARKER,
    documentId: DOC_ID,
    page: 1,
    charStart: 0,
    charEnd: 42,
    text: "Die Probezeit betraegt acht Monate ab Beginn.",
  },
];

const FOR_PROMPT: ReportInputClause[] = [
  {
    clauseId: CLAUSE_ID,
    serializedClauseId: MARKER,
    clauseRef: "1:1",
    page: 1,
    heading: "Probezeit",
    text: "Die Probezeit betraegt acht Monate ab Beginn.",
  },
];

const DOCUMENTS: ReportInputDocument[] = [
  {
    documentId: DOC_ID,
    filename: "offer_de.pdf",
    type: "employment_offer",
    language: "de",
    fields: [
      {
        fieldPath: "probation.months",
        value: 8,
        unit: "months",
        confidence: "high",
        status: "extracted",
        citations: [
          {
            clauseId: CLAUSE_ID,
            serializedClauseId: MARKER,
            clauseRef: "1:1",
            page: 1,
            heading: "Probezeit",
            charStart: 0,
            charEnd: 42,
            verbatimAnchor: "Die Probezeit",
          },
        ],
      },
    ],
    flags: [],
  },
];

/** Returns each scripted answer in turn, so a correction can be forced. */
class ScriptedLlm implements LlmProvider {
  readonly id = "scripted:llm";
  readonly calls: LlmConverseOptions[] = [];
  private index = 0;

  constructor(private readonly answers: string[]) {}

  extract(_opts: LlmExtractOptions): Promise<LlmExtractResult> {
    throw new Error("not used");
  }

  converse(opts: LlmConverseOptions): Promise<LlmConverseResult> {
    this.calls.push(opts);
    const text = this.answers[Math.min(this.index++, this.answers.length - 1)] ?? "";
    opts.onTextDelta?.(text);
    return Promise.resolve({
      stopReason: "end_turn",
      content: [{ type: "text", text }],
      usage: { inputTokens: 10, outputTokens: 20 },
    });
  }
}

const run = (answers: string[], onEvent?: (e: NarrativeEvent) => void) =>
  generateNarrative(
    { agentLlm: new ScriptedLlm(answers) },
    {
      caseTitle: "Senior Engineer offer",
      documents: DOCUMENTS,
      citable: CITABLE,
      forPrompt: FOR_PROMPT,
      ...(onEvent ? { onEvent } : {}),
    },
  );

describe("generateNarrative", () => {
  it("accepts a properly cited report on the first attempt", async () => {
    const result = await run([`## Summary\n\nProbation runs eight months. [[${MARKER}]]`]);

    expect(result.grounded).toBe(true);
    expect(result.corrected).toBe(false);
    expect(result.citations.map((c) => c.clauseId)).toEqual([CLAUSE_ID]);
    expect(result.trace.corrections).toEqual([]);
    expect(result.trace.stubbed).toBe(false);
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 20 });
  });

  it("converses with no tools at all", async () => {
    const llm = new ScriptedLlm([`Probation runs eight months. [[${MARKER}]]`]);
    await generateNarrative(
      { agentLlm: llm },
      { caseTitle: "t", documents: DOCUMENTS, citable: CITABLE, forPrompt: FOR_PROMPT },
    );
    expect(llm.calls[0]!.tools).toEqual([]);
  });

  // The narrative may only cite what the deterministic pipeline already tied to
  // a term or a rule — an id it invents must be rejected exactly like one the
  // agent loop invents.
  it("rejects a clause id that is not in the pre-seeded citable set", async () => {
    const invented = `${DOC_ID}:9:9`;
    const result = await run([
      `## Summary\n\nProbation runs eight months. [[${invented}]]`,
      `## Summary\n\nProbation runs eight months. [[${invented}]]`,
    ]);

    expect(result.grounded).toBe(false);
    expect(result.citations).toEqual([]);
    // The invented id is recorded as an unresolved marker, which is what the
    // trace drawer shows and what an injection suite would read.
    expect(result.trace.corrections[0]!.unresolvedMarkers).toContain(invented);
  });

  it("buys exactly one corrective regeneration, then surfaces what is left", async () => {
    const uncited = "## Summary\n\nProbation runs eight months.";
    const good = `## Summary\n\nProbation runs eight months. [[${MARKER}]]`;

    const corrected = await run([uncited, good]);
    expect(corrected.corrected).toBe(true);
    expect(corrected.grounded).toBe(true);
    expect(corrected.trace.corrections).toHaveLength(1);
    // Both attempts are billed, so cost must accumulate across them.
    expect(corrected.usage.outputTokens).toBe(40);

    const stillBad = await run([uncited, uncited]);
    expect(stillBad.corrected).toBe(true);
    expect(stillBad.grounded).toBe(false);
    // FR-5.2: surfaced under "could not verify" rather than silently dropped.
    expect(stillBad.couldNotVerify.length).toBeGreaterThan(0);
    expect(stillBad.trace.corrections).toHaveLength(1);
  });

  /**
   * `ask` deliberately does not stream its correction, so its streamed tokens
   * and final answer diverge. A multi-paragraph report cannot afford that, so
   * this one streams both and tells the client to clear its buffer.
   */
  it("emits retry then restart, and streams the corrected text too", async () => {
    const events: NarrativeEvent[] = [];
    const good = `## Summary\n\nProbation runs eight months. [[${MARKER}]]`;
    const result = await run(["## Summary\n\nProbation runs eight months.", good], (e) =>
      events.push(e),
    );

    const types = events.map((e) => e.type);
    expect(types).toContain("retry");
    expect(types).toContain("restart");
    expect(types.indexOf("retry")).toBeLessThan(types.indexOf("restart"));

    // The corrected text was streamed after the restart, not withheld.
    const afterRestart = events
      .slice(types.indexOf("restart") + 1)
      .filter((e): e is { type: "token"; text: string } => e.type === "token")
      .map((e) => e.text)
      .join("");
    expect(afterRestart).toBe(good);
    expect(result.markdown).toBe(good);
  });

  // Keyless mode: FakeLlm reports every field not_found and no rule fires, so
  // there is nothing to cite. Calling a model then could only produce an
  // ungrounded answer.
  it("short-circuits to a deterministic stub when nothing is citable", async () => {
    const llm = new ScriptedLlm(["should never be called"]);
    const result = await generateNarrative(
      { agentLlm: llm },
      { caseTitle: "Empty case", documents: [], citable: [], forPrompt: [] },
    );

    expect(llm.calls).toHaveLength(0);
    expect(result.trace.stubbed).toBe(true);
    expect(result.grounded).toBe(true);
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(result.markdown).toContain("## Summary");
    expect(result.markdown).toContain("Empty case");
    // The stub is a whole second construction site for this object, and it is
    // the one keyless CI exercises — so it has to satisfy the same contract.
    expect(narrativeTraceSchema.safeParse(result.trace).success).toBe(true);
  });

  /**
   * `narrativeSchema.trace` is what `GET .../narrative` publishes and what the
   * web parses, so a value this writer emits but that schema rejects would only
   * surface as a `ResponseShapeError` in a browser.
   */
  it("emits a trace the published schema accepts", async () => {
    const result = await run([`## Summary\n\nProbation runs eight months. [[${MARKER}]]`]);

    const parsed = narrativeTraceSchema.safeParse(result.trace);
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(parsed.success).toBe(true);
    // Serialized, matching the agent loop. This used to be the row uuid, which
    // meant one published field named two different things depending on path.
    expect(result.trace.citableClauseIds).toEqual([MARKER]);
  });

  /**
   * The live run that motivated this: Sonnet 5 at `effort: high` spent an
   * entire 4k budget on reasoning and returned no text, which the validator
   * happily called grounded — an empty report that looks like a success is
   * worse than an error.
   */
  it("fails loudly on empty output rather than reporting it as grounded", async () => {
    await expect(run([""])).rejects.toThrow(/produced no text/);
  });

  it("fails on a truncated report rather than citing half a sentence", async () => {
    class TruncatingLlm extends ScriptedLlm {
      override converse(opts: LlmConverseOptions): Promise<LlmConverseResult> {
        void super.converse(opts);
        return Promise.resolve({
          stopReason: "max_tokens",
          content: [{ type: "text", text: "## Summary\n\nProbation runs eight mon" }],
          usage: { inputTokens: 10, outputTokens: 20 },
        });
      }
    }
    await expect(
      generateNarrative(
        { agentLlm: new TruncatingLlm([""]) },
        { caseTitle: "t", documents: DOCUMENTS, citable: CITABLE, forPrompt: FOR_PROMPT },
      ),
    ).rejects.toThrow(/token ceiling/);
  });

  it("passes the citable clause text and ids into the prompt", async () => {
    const llm = new ScriptedLlm([`Probation. [[${MARKER}]]`]);
    await generateNarrative(
      { agentLlm: llm },
      { caseTitle: "t", documents: DOCUMENTS, citable: CITABLE, forPrompt: FOR_PROMPT },
    );

    const sent = llm.calls[0]!.messages[0]!.content.filter(
      (b): b is Extract<typeof b, { type: "text" }> => b.type === "text",
    )
      .map((b) => b.text)
      .join("");
    expect(sent).toContain(MARKER);
    expect(sent).toContain("Die Probezeit betraegt acht Monate ab Beginn.");
    expect(sent).toContain("probation.months: 8 months");
  });
});
