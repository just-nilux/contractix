/**
 * Where a request's tenant comes from (FR-6.2, FR-7.4).
 *
 * Exactly one source: the signed session cookie (or the equivalent bearer
 * token). Never a path param, never a header a client can pick, never a tool
 * argument - the same rule ADR-0010 states for the agent's tool surface, held
 * one layer up.
 *
 * Three middlewares, because "who are you", "you must be someone" and "you are
 * someone now" are different questions:
 *
 * - `sessionMiddleware` reads and verifies. Never writes a tenant. Runs on
 *   everything.
 * - `requireTenant` 401s when there is no verified session.
 * - `ensureTenant` mints one. Mounted only on the two routes that legitimately
 *   start a session, so a crawler hitting `/healthz` cannot fill the tenants
 *   table with rows nobody will ever use.
 */
import { eq } from "drizzle-orm";
import { type Context, type MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";

import { type Db } from "../db/client.js";
import { tenants } from "../db/schema/index.js";
import { logger } from "../logger.js";
import {
  bearerToken,
  SESSION_COOKIE,
  type SessionClaims,
  setSessionCookie,
  shouldRefresh,
  signSession,
  verifySession,
} from "./session.js";

export interface AuthConfig {
  secret: string;
  ttlSec: number;
  /** `Secure` on the cookie; false in dev, where there is no TLS. */
  secureCookie: boolean;
}

export interface AuthDeps {
  db: Db;
  auth: AuthConfig;
}

export interface AppEnv {
  Variables: {
    /** Null until `requireTenant`/`ensureTenant` has run and passed. */
    tenantId: string | null;
    session: SessionClaims | null;
    /** Set when a cookie was presented but did not survive verification. */
    sessionError: "expired" | "invalid" | null;
  };
}

async function mintTenant(deps: AuthDeps, c: Context): Promise<string> {
  const expiresAt = new Date(Date.now() + deps.auth.ttlSec * 1000);
  const rows = await deps.db
    .insert(tenants)
    .values({ name: `anon-${expiresAt.toISOString()}`, kind: "anon", expiresAt })
    .returning({ id: tenants.id });
  const row = rows[0];
  if (!row) throw new Error("failed to mint anonymous tenant");

  const token = await signSession(row.id, deps.auth.secret, deps.auth.ttlSec);
  setSessionCookie(c, token, deps.auth.ttlSec, deps.auth.secureCookie);
  logger.info({ tenantId: row.id }, "anonymous session minted");
  return row.id;
}

export function sessionMiddleware(deps: AuthDeps): MiddlewareHandler<AppEnv> {
  return createMiddleware<AppEnv>(async (c, next) => {
    c.set("tenantId", null);
    c.set("session", null);
    c.set("sessionError", null);

    // Cookie first, bearer second: the browser is the primary client, and the
    // bearer path exists so the Phase-4 MCP server (FR-6.3) needs no second
    // auth mechanism.
    const token = getCookie(c, SESSION_COOKIE) ?? bearerToken(c.req.header("authorization"));
    if (!token) return next();

    const verdict = await verifySession(token, deps.auth.secret);
    if (!verdict.ok) {
      c.set("sessionError", verdict.reason);
      return next();
    }

    // A live token for a tenant the retention job already purged is the FR-7.3
    // case: the row is the real authority, so a stale cookie reads as an
    // expired session rather than a valid one.
    const rows = await deps.db
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.id, verdict.claims.sub))
      .limit(1);
    if (!rows[0]) {
      c.set("sessionError", "expired");
      return next();
    }

    c.set("tenantId", verdict.claims.sub);
    c.set("session", verdict.claims);

    // Slide the window for an active visitor so a case cannot expire mid-read.
    if (shouldRefresh(verdict.claims)) {
      const expiresAt = new Date(Date.now() + deps.auth.ttlSec * 1000);
      await deps.db
        .update(tenants)
        .set({ expiresAt })
        .where(eq(tenants.id, verdict.claims.sub));
      const fresh = await signSession(verdict.claims.sub, deps.auth.secret, deps.auth.ttlSec);
      setSessionCookie(c, fresh, deps.auth.ttlSec, deps.auth.secureCookie);
    }

    return next();
  });
}

/**
 * 401s distinguishably: `no_session` is a first visit and the web shows the
 * landing page; `session_expired` means the 24 h demo ended and the documents
 * are gone, which is worth saying out loud.
 */
export const requireTenant: MiddlewareHandler<AppEnv> = createMiddleware<AppEnv>(
  async (c, next) => {
    if (c.get("tenantId")) return next();

    const expired = c.get("sessionError") !== null;
    return c.json(
      {
        error: expired ? "session_expired" : "no_session",
        message: expired
          ? "This anonymous session has expired; its documents have been deleted."
          : "No session. Start one by creating a case or adopting the demo corpus.",
      },
      401,
    );
  },
);

export function ensureTenant(deps: AuthDeps): MiddlewareHandler<AppEnv> {
  return createMiddleware<AppEnv>(async (c, next) => {
    if (!c.get("tenantId")) c.set("tenantId", await mintTenant(deps, c));
    return next();
  });
}

/**
 * `c.get("tenantId")` is nullable because `sessionMiddleware` runs everywhere,
 * including on the routes that allow anonymous access. A handler behind
 * `requireTenant`/`ensureTenant` knows better than the type does; this throws
 * rather than returning a fallback, so a route mounted without its middleware
 * fails loudly instead of quietly reading someone else's data.
 */
export function tenantOf(c: Context<AppEnv>): string {
  const tenantId = c.get("tenantId");
  if (!tenantId) throw new Error("handler ran without requireTenant/ensureTenant");
  return tenantId;
}
