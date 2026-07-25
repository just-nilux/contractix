import {
  type JsonSchema,
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
export class FakeLlm implements LlmProvider {
  readonly id = "fake:llm";

  extract(opts: LlmExtractOptions): Promise<LlmExtractResult> {
    const json = fakeValueForSchema(opts.jsonSchema, opts.jsonSchema);
    return Promise.resolve({ json, usage: { inputTokens: 0, outputTokens: 0 } });
  }
}
