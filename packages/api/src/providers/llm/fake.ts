import {
  type JsonSchema,
  type LlmContentBlock,
  type LlmConverseOptions,
  type LlmConverseResult,
  type LlmExtractOptions,
  type LlmExtractResult,
  type LlmProvider,
} from "./types.js";

function asObject(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/** Resolve a local "#/$defs/Name" (or "#/definitions/Name") ref against the schema root. */
function resolveRef(ref: string, root: JsonSchema): JsonSchema | null {
  const m = /^#\/(\$defs|definitions)\/(.+)$/u.exec(ref);
  const bucketKey = m?.[1];
  const name = m?.[2];
  if (bucketKey === undefined || name === undefined) return null;
  const bucket = asObject(root[bucketKey]);
  return bucket ? asObject(bucket[name]) : null;
}

/** Honest fake: prefer the "nothing was found" member of a metadata enum. */
function pickEnum(values: unknown[], key: string | undefined): unknown {
  if (key === "status" && values.includes("not_found")) return "not_found";
  if (key === "confidence" && values.includes("low")) return "low";
  // Classification has no "not found" member; "other" is its honest no-signal
  // answer, so keyless analysis runs end to end (extract skips the null family).
  if (key === "document_type" && values.includes("other")) return "other";
  return values[0] ?? null;
}

/** Deterministic schema-shaped default. No randomness — stable across runs. */
function fakeValueForSchema(schema: JsonSchema, root: JsonSchema, key?: string): unknown {
  if (typeof schema.$ref === "string") {
    const target = resolveRef(schema.$ref, root);
    return target ? fakeValueForSchema(target, root, key) : null;
  }
  if ("const" in schema) return schema.const;
  if (Array.isArray(schema.enum)) return pickEnum(schema.enum, key);

  const union = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(union)) {
    const branches = union.map(asObject).filter((b): b is Record<string, unknown> => b !== null);
    if (branches.some((b) => b.type === "null")) return null;
    const first = branches[0];
    return first ? fakeValueForSchema(first, root, key) : null;
  }

  let type = schema.type;
  if (Array.isArray(type)) {
    if (type.includes("null")) return null;
    type = type[0];
  }

  switch (type) {
    case "null":
      return null;
    case "string":
      return "";
    case "number":
    case "integer":
      return 0;
    case "boolean":
      return false;
    case "array":
      return [];
    case "object":
    case undefined: {
      const props = asObject(schema.properties);
      if (!props) return type === "object" ? {} : null;
      const out: Record<string, unknown> = {};
      for (const [name, sub] of Object.entries(props)) {
        const subObj = asObject(sub);
        if (subObj) out[name] = fakeValueForSchema(subObj, root, name);
      }
      return out;
    }
    default:
      return null;
  }
}

/**
 * Deterministic keyless LLM. Mirrors FakeEmbeddings: never touches the network,
 * never used in production (the factory enforces). It walks the requested JSON
 * schema and returns a schema-valid object reporting `not_found`/null for every
 * field — enough to exercise validation, the repair path, citation resolution,
 * and persistence end to end. Real extraction values require Anthropic, so the
 * extraction eval baseline is live-gated exactly like the embeddings baseline.
 */
/** Serialized clause ids ({uuid}:{page}:{path}) embedded in a tool result payload. */
const CLAUSE_ID_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:\d+:[^"\s,\]}]+/giu;

const SEARCH_TOOL = "search_clauses";
/** Two tool turns is plenty to exercise the loop; past that the fake answers. */
const MAX_FAKE_TOOL_TURNS = 2;

function textOf(blocks: LlmContentBlock[]): string {
  return blocks
    .filter((b): b is Extract<LlmContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join(" ");
}

export class FakeLlm implements LlmProvider {
  readonly id = "fake:llm";

  extract(opts: LlmExtractOptions): Promise<LlmExtractResult> {
    const json = fakeValueForSchema(opts.jsonSchema, opts.jsonSchema);
    return Promise.resolve({ json, usage: { inputTokens: 0, outputTokens: 0 } });
  }

  /**
   * Scripted two-phase loop: retrieve once, then answer citing exactly what came
   * back. The schema-walking trick `extract` uses cannot express a tool loop, so
   * this is hand-written instead — its job is to keep the agent loop, grounding
   * validator, citation persistence and SSE path exercised in keyless CI, not to
   * produce a real answer. It never claims knowledge it does not have: with no
   * retrieved clause it emits an uncited sentence, which the validator correctly
   * routes to "could not verify".
   */
  converse(opts: LlmConverseOptions): Promise<LlmConverseResult> {
    const usage = { inputTokens: 0, outputTokens: 0 };
    const toolTurns = opts.messages.filter(
      (m) => m.role === "assistant" && m.content.some((b) => b.type === "tool_use"),
    ).length;

    const results = opts.messages.flatMap((m) =>
      m.content.filter(
        (b): b is Extract<LlmContentBlock, { type: "tool_result" }> => b.type === "tool_result",
      ),
    );
    const hasSearchTool = opts.tools.some((t) => t.name === SEARCH_TOOL);

    if (results.length === 0 && hasSearchTool && toolTurns < MAX_FAKE_TOOL_TURNS) {
      const question = textOf(opts.messages.at(-1)?.content ?? []);
      return Promise.resolve({
        stopReason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: `fake-tool-${toolTurns + 1}`,
            name: SEARCH_TOOL,
            input: { query: question.slice(0, 400) },
          },
        ],
        usage,
      });
    }

    // Tool results first, then any text block: the agent loop supplies clause
    // ids through tool output, but the narrative report writer hands them over
    // in the user message, and keyless CI must exercise both.
    const scannable = [
      ...results.map((r) => r.content),
      ...opts.messages.flatMap((m) =>
        m.content
          .filter((b): b is Extract<LlmContentBlock, { type: "text" }> => b.type === "text")
          .map((b) => b.text),
      ),
    ];
    const cited = [...new Set(scannable.flatMap((t) => t.match(CLAUSE_ID_RE) ?? []))].slice(0, 2);
    const text =
      cited.length > 0
        ? `Keyless mode returns no model-generated analysis; the retrieved clause is cited so the citation path stays verifiable. ${cited
            .map((id) => `[[${id}]]`)
            .join(" ")}`
        : "Keyless mode returns no model-generated analysis, and retrieval matched no clause for this question.";

    const stream = opts.onTextDelta;
    if (stream) for (const word of text.split(/(?<=\s)/u)) stream(word);

    return Promise.resolve({
      stopReason: "end_turn",
      content: [{ type: "text", text }],
      usage,
    });
  }
}
