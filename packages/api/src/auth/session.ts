/**
 * Anonymous sessions (PRD FR-6.2: "JWT auth; anonymous demo tenant with rate
 * limits").
 *
 * A session is a signed assertion of one thing - which tenant this request is
 * scoped to. There are no accounts in v1, so `sub` is a tenant id and nothing
 * else; every query then keeps FR-7.4's single `tenant_id` equality guard.
 *
 * A JWT rather than a Hono signed cookie, for two reasons: `exp` is the same
 * 24 h contract the FR-7.3 retention job enforces, so the lifetime is one
 * number with two enforcers rather than two numbers that can disagree; and the
 * identical token rides `Authorization: Bearer` for the Phase-4 MCP server
 * (FR-6.3) with no second mechanism to build.
 *
 * The token cannot be revoked mid-life. The tenant row is the real authority -
 * purge it and every query returns nothing - which is revocation by data
 * deletion, and is exactly what the 24 h purge does. Real accounts would need a
 * session table; anonymous demo sessions do not.
 */
import { type Context } from "hono";
import { setCookie } from "hono/cookie";
import { sign, verify } from "hono/jwt";

export const SESSION_COOKIE = "ctx_sid";
const ALG = "HS256";

/** The index signature is what `hono/jwt` wants of a JWTPayload. */
export interface SessionClaims {
  /** Tenant id. The only thing a session asserts. */
  sub: string;
  kind: "anon";
  iat: number;
  exp: number;
  [claim: string]: unknown;
}

export type SessionVerdict =
  | { ok: true; claims: SessionClaims }
  | { ok: false; reason: "expired" | "invalid" };

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

export async function signSession(
  tenantId: string,
  secret: string,
  ttlSec: number,
): Promise<string> {
  const iat = nowSec();
  const claims: SessionClaims = { sub: tenantId, kind: "anon", iat, exp: iat + ttlSec };
  return sign(claims, secret, ALG);
}

/**
 * Never throws: a bad cookie is an ordinary request state, not an exception.
 * `expired` and `invalid` are kept apart because the first is a thing worth
 * telling the user ("your 24-hour demo ended") and the second is not.
 */
export async function verifySession(token: string, secret: string): Promise<SessionVerdict> {
  let payload: unknown;
  try {
    payload = await verify(token, secret, ALG);
  } catch (err) {
    // hono's jwt errors are anonymous classes that set `name` on the instance,
    // so `constructor.name` is empty - match on `name`.
    const expired = err instanceof Error && err.name === "JwtTokenExpired";
    return { ok: false, reason: expired ? "expired" : "invalid" };
  }

  // A token can be correctly signed and still not be one of ours - an old
  // shape, or a token minted for something else with the same secret.
  if (
    typeof payload !== "object" ||
    payload === null ||
    typeof (payload as SessionClaims).sub !== "string" ||
    (payload as SessionClaims).kind !== "anon" ||
    typeof (payload as SessionClaims).iat !== "number" ||
    typeof (payload as SessionClaims).exp !== "number"
  ) {
    return { ok: false, reason: "invalid" };
  }

  return { ok: true, claims: payload as unknown as SessionClaims };
}

/**
 * True once the token is past half its life. Re-issuing then keeps an active
 * visitor from losing a case mid-read at hour 23:59, without minting a fresh
 * cookie on every single request.
 */
export function shouldRefresh(claims: SessionClaims): boolean {
  const midpoint = claims.iat + (claims.exp - claims.iat) / 2;
  return nowSec() >= midpoint;
}

export function setSessionCookie(
  c: Context,
  token: string,
  ttlSec: number,
  secure: boolean,
): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    secure,
    maxAge: ttlSec,
  });
}

/** `Authorization: Bearer <jwt>` - the same token, for the Phase-4 MCP server. */
export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, token] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) return null;
  return token;
}
