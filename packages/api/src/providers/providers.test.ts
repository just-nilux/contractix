import { parseModelsConfig } from "@contractix/shared";
import { describe, expect, it, vi } from "vitest";

import { FakeEmbeddings } from "./embeddings/fake.js";
import { JinaEmbeddings } from "./embeddings/jina.js";
import { createProviders } from "./index.js";
import { AnthropicLlm } from "./llm/anthropic.js";
import { FakeLlm } from "./llm/fake.js";
import { JinaReranker } from "./reranker/jina.js";
import { PassthroughReranker } from "./reranker/passthrough.js";

const YAML = `
version: 1
embeddings: { provider: jina, model: test-embed, dimensions: 32, api_key_env: JINA_API_KEY, base_url: "https://jina.test/v1" }
reranker: { provider: jina, model: test-rerank, api_key_env: JINA_API_KEY, base_url: "https://jina.test/v1" }
llm:
  primary: { provider: anthropic, model: a, small_model: b, api_key_env: ANTHROPIC_API_KEY }
  fallback: { provider: openai, model: null, api_key_env: OPENAI_API_KEY }
`;
const cfg = parseModelsConfig(YAML);

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return dot;
}

/** Typed fetch stub: hands the handler the URL and parsed JSON body. */
function mockFetch(
  handler: (url: string, body: Record<string, unknown>) => Response,
): typeof fetch {
  const fn = (url: unknown, init?: { body?: unknown }) => {
    const body =
      typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    return Promise.resolve(handler(String(url), body));
  };
  return fn;
}

describe("FakeEmbeddings", () => {
  it("is deterministic and L2-normalized", async () => {
    const fake = new FakeEmbeddings(64);
    const [a] = await fake.embed(["Die Probezeit beträgt sechs Monate."], {
      inputType: "document",
    });
    const [b] = await fake.embed(["Die Probezeit beträgt sechs Monate."], {
      inputType: "query",
    });
    expect(a).toEqual(b);
    const norm = Math.sqrt((a ?? []).reduce((acc, x) => acc + x * x, 0));
    expect(norm).toBeCloseTo(1, 6);
  });

  it("is weakly semantic: overlap beats disjoint text", async () => {
    const fake = new FakeEmbeddings(256);
    const [probezeit, probezeitFrage, liqpref] = await fake.embed(
      [
        "Die Probezeit beträgt sechs Monate.",
        "Wie lange ist die Probezeit?",
        "Liquidation preference of one times non-participating.",
      ],
      { inputType: "document" },
    );
    expect(cosine(probezeit ?? [], probezeitFrage ?? [])).toBeGreaterThan(
      cosine(probezeit ?? [], liqpref ?? []),
    );
  });
});

describe("createProviders", () => {
  it("uses real providers when keys are present", () => {
    const bundle = createProviders(cfg, {
      envVars: { JINA_API_KEY: "k", ANTHROPIC_API_KEY: "k" },
      production: false,
    });
    expect(bundle.embeddings).toBeInstanceOf(JinaEmbeddings);
    expect(bundle.embeddings.id).toBe("jina:test-embed@32");
    expect(bundle.reranker).toBeInstanceOf(JinaReranker);
    expect(bundle.llm).toBeInstanceOf(AnthropicLlm);
    // Extraction binds to the small model (ADR-0004), not the primary.
    expect(bundle.llm.id).toBe("anthropic:b");
  });

  it("degrades to fakes without keys outside production, with a fallback hook", () => {
    const onFallback = vi.fn();
    const bundle = createProviders(cfg, { envVars: {}, production: false, onFallback });
    expect(bundle.embeddings).toBeInstanceOf(FakeEmbeddings);
    expect(bundle.reranker).toBeInstanceOf(PassthroughReranker);
    expect(bundle.llm).toBeInstanceOf(FakeLlm);
    expect(onFallback).toHaveBeenCalledWith("embeddings", "missing JINA_API_KEY");
    expect(onFallback).toHaveBeenCalledWith("reranker", "missing JINA_API_KEY");
    expect(onFallback).toHaveBeenCalledWith("llm", "missing ANTHROPIC_API_KEY");
  });

  it("throws in production when the embeddings key is missing", () => {
    expect(() => createProviders(cfg, { envVars: {}, production: true })).toThrow(/JINA_API_KEY/);
  });

  it("throws in production when the llm key is missing", () => {
    expect(() =>
      createProviders(cfg, { envVars: { JINA_API_KEY: "k" }, production: true }),
    ).toThrow(/ANTHROPIC_API_KEY/);
  });
});

describe("JinaEmbeddings", () => {
  it("batches, maps task types, and validates dimensions", async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const fetchFn = mockFetch((url, body) => {
      calls.push({ url, body });
      const input = body.input as string[];
      return new Response(
        JSON.stringify({
          data: input.map((_, index) => ({ index, embedding: [1, 0, 0] })),
        }),
        { status: 200 },
      );
    });

    const jina = new JinaEmbeddings(
      { model: "test-embed", dimensions: 3, apiKey: "k", baseUrl: "https://jina.test/v1" },
      { fetchFn },
    );

    const out = await jina.embed(["a", "b"], { inputType: "query" });
    expect(out).toHaveLength(2);
    expect(calls[0]?.url).toBe("https://jina.test/v1/embeddings");
    expect(calls[0]?.body.task).toBe("retrieval.query");
    expect(calls[0]?.body.dimensions).toBe(3);

    await expect(
      new JinaEmbeddings(
        { model: "m", dimensions: 5, apiKey: "k", baseUrl: "https://jina.test/v1" },
        { fetchFn },
      ).embed(["a"], { inputType: "document" }),
    ).rejects.toThrow(/dims/);
  });

  it("retries on 429 with backoff", async () => {
    let attempts = 0;
    const fetchFn = mockFetch(() => {
      attempts++;
      if (attempts === 1) return new Response("rate limited", { status: 429 });
      return new Response(JSON.stringify({ data: [{ index: 0, embedding: [1] }] }), {
        status: 200,
      });
    });
    const jina = new JinaEmbeddings(
      { model: "m", dimensions: 1, apiKey: "k", baseUrl: "https://jina.test/v1" },
      { fetchFn, sleep: () => Promise.resolve() },
    );
    const out = await jina.embed(["a"], { inputType: "document" });
    expect(out).toEqual([[1]]);
    expect(attempts).toBe(2);
  });
});

describe("JinaReranker", () => {
  it("maps result indices back to doc ids", async () => {
    const fetchFn = mockFetch(
      () =>
        new Response(
          JSON.stringify({
            results: [
              { index: 1, relevance_score: 0.9 },
              { index: 0, relevance_score: 0.2 },
            ],
          }),
          { status: 200 },
        ),
    );
    const reranker = new JinaReranker(
      { model: "test-rerank", apiKey: "k", baseUrl: "https://jina.test/v1" },
      { fetchFn },
    );
    const out = await reranker.rerank(
      "probezeit",
      [
        { id: "c1", text: "Urlaub beträgt 30 Tage" },
        { id: "c2", text: "Die Probezeit beträgt sechs Monate" },
      ],
      2,
    );
    expect(out).toEqual([
      { id: "c2", score: 0.9 },
      { id: "c1", score: 0.2 },
    ]);
  });

  it("returns empty for empty candidate sets without calling the API", async () => {
    let called = 0;
    const fetchFn = mockFetch(() => {
      called++;
      return new Response("{}", { status: 200 });
    });
    const reranker = new JinaReranker(
      { model: "m", apiKey: "k", baseUrl: "https://jina.test/v1" },
      { fetchFn },
    );
    expect(await reranker.rerank("q", [], 8)).toEqual([]);
    expect(called).toBe(0);
  });
});

describe("AnthropicLlm", () => {
  it("forces the tool and returns its input plus token usage", async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const fetchFn = mockFetch((url, body) => {
      calls.push({ url, body });
      return new Response(
        JSON.stringify({
          content: [
            { type: "text", text: "narration the model should not add" },
            { type: "tool_use", name: "record_extraction", input: { ok: true } },
          ],
          usage: { input_tokens: 11, output_tokens: 7 },
        }),
        { status: 200 },
      );
    });
    const llm = new AnthropicLlm({ model: "claude-haiku", apiKey: "k" }, { fetchFn });

    const res = await llm.extract({
      system: "sys",
      user: "clause-structured document",
      toolName: "record_extraction",
      jsonSchema: { type: "object" },
    });

    expect(res.json).toEqual({ ok: true });
    expect(res.usage).toEqual({ inputTokens: 11, outputTokens: 7 });
    expect(llm.id).toBe("anthropic:claude-haiku");
    expect(calls[0]?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(calls[0]?.body.tool_choice).toEqual({ type: "tool", name: "record_extraction" });
    expect(calls[0]?.body.temperature).toBe(0);
  });

  it("throws when the forced tool_use block is absent", async () => {
    const fetchFn = mockFetch(
      () =>
        new Response(
          JSON.stringify({
            content: [{ type: "text", text: "no tool call" }],
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          { status: 200 },
        ),
    );
    const llm = new AnthropicLlm({ model: "m", apiKey: "k" }, { fetchFn });
    await expect(
      llm.extract({ system: "s", user: "u", toolName: "record_extraction", jsonSchema: {} }),
    ).rejects.toThrow(/tool_use/);
  });
});

describe("FakeLlm", () => {
  it("returns a deterministic, schema-valid not_found object", async () => {
    const llm = new FakeLlm();
    const jsonSchema = {
      type: "object",
      properties: {
        document_type: { const: "employment_offer" },
        base_salary: {
          type: "object",
          properties: {
            value: { anyOf: [{ type: "number" }, { type: "null" }] },
            confidence: { enum: ["high", "medium", "low"] },
            status: { enum: ["extracted", "not_found", "extraction_failed"] },
            citations: { type: "array", items: { type: "string" } },
            verbatim_anchor: { type: "string" },
          },
        },
      },
    };

    const a = await llm.extract({ system: "s", user: "u", toolName: "t", jsonSchema });
    const b = await llm.extract({ system: "s", user: "different doc", toolName: "t", jsonSchema });

    expect(a.json).toEqual(b.json);
    expect(a.json).toEqual({
      document_type: "employment_offer",
      base_salary: {
        value: null,
        confidence: "low",
        status: "not_found",
        citations: [],
        verbatim_anchor: "",
      },
    });
    expect(a.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(llm.id).toBe("fake:llm");
  });

  it("resolves $ref against $defs (Zod 4 reused-schema output)", async () => {
    const llm = new FakeLlm();
    const jsonSchema = {
      type: "object",
      properties: { field: { $ref: "#/$defs/Cited" } },
      $defs: {
        Cited: { type: "object", properties: { status: { enum: ["extracted", "not_found"] } } },
      },
    };
    const res = await llm.extract({ system: "s", user: "u", toolName: "t", jsonSchema });
    expect(res.json).toEqual({ field: { status: "not_found" } });
  });
});
