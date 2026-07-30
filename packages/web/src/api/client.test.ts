import { caseSchema, DISCLAIMER } from "@contractix/shared/schemas";
import { afterEach, describe, expect, it, vi } from "vitest";

import { request, requestVoid } from "./client.js";
import {
  ConflictError,
  HttpError,
  NotFoundError,
  PayloadTooLargeError,
  RateLimitError,
  ResponseShapeError,
  SessionError,
  UnavailableError,
  UnsupportedMediaError,
} from "./errors.js";

/**
 * Builds a Response whose body *throws* if read, so a test can assert that the
 * client does not touch the body of the statuses the API sends empty.
 */
function bodylessResponse(status: number): Response {
  return {
    ok: false,
    status,
    headers: new Headers(),
    json: () => Promise.reject(new Error("body must not be read")),
    text: () => Promise.reject(new Error("body must not be read")),
  } as unknown as Response;
}

function jsonResponse(status: number, body: unknown, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function stubFetch(res: Response) {
  const fn = vi.fn<typeof fetch>().mockResolvedValue(res);
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("request", () => {
  it("parses a 200 with the schema the API publishes", async () => {
    const body = {
      id: "018f4b3e-7c2a-7000-8000-000000000001",
      title: "Offer from Acme",
      retentionDays: 1,
      createdAt: "2026-07-28T10:00:00.000Z",
    };
    const fetchMock = stubFetch(jsonResponse(200, body));

    await expect(request("/cases/x", { schema: caseSchema })).resolves.toEqual(body);

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("/api/cases/x");
    // Same-origin, not include: there is deliberately no CORS setup to rely on.
    expect(init?.credentials).toBe("same-origin");
  });

  it("reports a 2xx that does not match its published schema", async () => {
    stubFetch(jsonResponse(200, { id: "not-a-uuid", title: "x" }));

    const err = await request("/cases/x", { schema: caseSchema }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ResponseShapeError);
    // Naming the offending field is the entire point of parsing client-side.
    expect((err as ResponseShapeError).issues.join(" ")).toContain("id");
  });

  it("omits a request body and content-type on a GET", async () => {
    const fetchMock = stubFetch(jsonResponse(200, { available: false, documents: [] }));

    await requestVoid("/demo");

    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.body).toBeUndefined();
    expect(new Headers(init?.headers).get("content-type")).toBeNull();
  });

  it("sends a JSON body with its content-type on a POST", async () => {
    const fetchMock = stubFetch(jsonResponse(200, {}));

    await requestVoid("/cases", { method: "POST", body: { title: "x" } });

    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.body).toBe('{"title":"x"}');
    expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
  });

  it("resolves a 204 without trying to parse a body", async () => {
    stubFetch(new Response(null, { status: 204 }));
    await expect(requestVoid("/cases/x", { method: "DELETE" })).resolves.toBeUndefined();
  });
});

describe("401 mapping", () => {
  it.each([
    ["no_session", "You do not have a session yet."],
    ["session_expired", "Your demo session expired."],
  ] as const)("carries the %s kind through", async (kind, message) => {
    stubFetch(jsonResponse(401, { error: kind, message }));

    const err = await request("/cases", { schema: caseSchema }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SessionError);
    expect((err as SessionError).kind).toBe(kind);
    expect((err as SessionError).message).toBe(message);
  });

  it("defaults to no_session when the body is not a session error", async () => {
    stubFetch(jsonResponse(401, { unexpected: true }));

    const err = await request("/cases", { schema: caseSchema }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SessionError);
    expect((err as SessionError).kind).toBe("no_session");
  });
});

describe("429 mapping", () => {
  it("reads the published rate-limit body", async () => {
    stubFetch(
      jsonResponse(429, {
        error: "rate_limited",
        scope: "ip",
        limit: 3,
        windowSeconds: 3600,
        retryAfterSeconds: 1234,
        message: "Too many requests in this window. This is a free anonymous demo.",
      }),
    );

    const err = await request("/demo/adopt", { schema: caseSchema, method: "POST" }).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(RateLimitError);
    expect(err).toMatchObject({ scope: "ip", limit: 3, windowSeconds: 3600 });
    expect((err as RateLimitError).retryAfterSeconds).toBe(1234);
  });

  it("falls back to the Retry-After header when the body is unreadable", async () => {
    stubFetch(new Response("gateway said no", { status: 429, headers: { "retry-after": "42" } }));

    const err = await request("/demo/adopt", { schema: caseSchema, method: "POST" }).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).retryAfterSeconds).toBe(42);
    // Unknown rather than invented: a header-only fallback knows less.
    expect((err as RateLimitError).limit).toBeNull();
    expect((err as RateLimitError).scope).toBeNull();
  });

  it("falls back to a default delay when there is no usable header either", async () => {
    stubFetch(new Response("nope", { status: 429 }));

    const err = await request("/demo/adopt", { schema: caseSchema, method: "POST" }).catch(
      (e: unknown) => e,
    );

    expect((err as RateLimitError).retryAfterSeconds).toBe(60);
  });
});

describe("empty-body statuses", () => {
  it.each([
    [404, NotFoundError],
    [409, ConflictError],
    [413, PayloadTooLargeError],
    [415, UnsupportedMediaError],
    [503, UnavailableError],
  ])("maps %i without reading the body", async (status, Expected) => {
    stubFetch(bodylessResponse(status));

    const err = await request("/x", { schema: caseSchema }).catch((e: unknown) => e);

    // The API sends these as `c.body(null, status)`; the stub throws if read.
    expect(err).toBeInstanceOf(Expected);
    expect((err as HttpError).status).toBe(status);
  });

  it("falls through to HttpError for an unmapped status", async () => {
    stubFetch(new Response("boom", { status: 500 }));

    const err = await request("/x", { schema: caseSchema }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).message).toContain("boom");
  });
});

describe("shared contract", () => {
  it("uses the API's own disclaimer string", () => {
    // Guards FR-7.6: the web's copy is imported, never retyped.
    expect(DISCLAIMER).toContain("not legal or tax advice");
  });
});
