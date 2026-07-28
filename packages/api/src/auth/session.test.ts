import { afterEach, describe, expect, it, vi } from "vitest";

import { bearerToken, shouldRefresh, signSession, verifySession } from "./session.js";

const SECRET = "test-secret";
const TTL = 24 * 60 * 60;
const TENANT = "0198f4d2-0000-7000-8000-000000000001";

afterEach(() => {
  vi.useRealTimers();
});

describe("signSession / verifySession", () => {
  it("round-trips the tenant id", async () => {
    const token = await signSession(TENANT, SECRET, TTL);
    const verdict = await verifySession(token, SECRET);

    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.claims.sub).toBe(TENANT);
    expect(verdict.claims.kind).toBe("anon");
    expect(verdict.claims.exp - verdict.claims.iat).toBe(TTL);
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await signSession(TENANT, SECRET, TTL);

    expect(await verifySession(token, "other-secret")).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("rejects a tampered payload", async () => {
    const token = await signSession(TENANT, SECRET, TTL);
    const [header, , signature] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({ sub: "someone-else", kind: "anon", iat: 1, exp: 2 ** 40 }),
    ).toString("base64url");

    expect(await verifySession(`${header}.${forged}.${signature}`, SECRET)).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("rejects garbage", async () => {
    expect(await verifySession("not-a-jwt", SECRET)).toEqual({ ok: false, reason: "invalid" });
  });

  // `expired` is kept apart from `invalid` because it is the one rejection
  // worth explaining to the user: the 24 h demo ended and the data is gone.
  it("reports an expired token as expired, not invalid", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-01T00:00:00Z"));
    const token = await signSession(TENANT, SECRET, TTL);

    vi.setSystemTime(new Date("2026-07-02T00:00:01Z"));

    expect(await verifySession(token, SECRET)).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects a correctly signed token that is not one of ours", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-01T00:00:00Z"));
    // Same secret, same alg, wrong shape - e.g. an older token format.
    const { sign } = await import("hono/jwt");
    const token = await sign({ sub: TENANT, exp: 2 ** 40 }, SECRET, "HS256");

    expect(await verifySession(token, SECRET)).toEqual({ ok: false, reason: "invalid" });
  });
});

describe("shouldRefresh", () => {
  it("is false in the first half of the token's life", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-01T00:00:00Z"));
    const iat = Math.floor(Date.now() / 1000);

    vi.setSystemTime(new Date("2026-07-01T11:59:00Z"));

    expect(shouldRefresh({ sub: TENANT, kind: "anon", iat, exp: iat + TTL })).toBe(false);
  });

  it("is true past the midpoint, so an active visitor never expires mid-read", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-01T00:00:00Z"));
    const iat = Math.floor(Date.now() / 1000);

    vi.setSystemTime(new Date("2026-07-01T12:00:01Z"));

    expect(shouldRefresh({ sub: TENANT, kind: "anon", iat, exp: iat + TTL })).toBe(true);
  });
});

describe("bearerToken", () => {
  it.each([
    ["Bearer abc.def.ghi", "abc.def.ghi"],
    ["bearer abc.def.ghi", "abc.def.ghi"],
    ["Basic abc", null],
    ["Bearer", null],
    ["", null],
    [undefined, null],
  ])("parses %j", (header, expected) => {
    expect(bearerToken(header)).toBe(expected);
  });
});
