/**
 * Test-only session helpers. Deliberately NOT exported from `src/index.ts`.
 *
 * Integration tests authenticate the way a browser does - by presenting a
 * signed cookie - rather than through a bypass header. A test-only auth bypass
 * is an auth bypass, and it would ship.
 */
import { eq } from "drizzle-orm";

import { type Db } from "../db/client.js";
import { tenants } from "../db/schema/index.js";
import { type AuthConfig } from "./middleware.js";
import { SESSION_COOKIE, signSession } from "./session.js";

export const TEST_AUTH: AuthConfig = {
  secret: "test-session-secret",
  ttlSec: 60 * 60,
  secureCookie: false,
};

/** A tenant row for tests that work below the HTTP layer. Delete it to clean up: everything cascades. */
export async function createTestTenant(db: Db, name: string): Promise<string> {
  const rows = await db
    .insert(tenants)
    .values({ name: `test-${name}-${Date.now()}`, kind: "anon" })
    .returning({ id: tenants.id });
  const row = rows[0];
  if (!row) throw new Error("failed to create test tenant");
  return row.id;
}

export async function deleteTestTenant(db: Db, tenantId: string): Promise<void> {
  await db.delete(tenants).where(eq(tenants.id, tenantId));
}

export async function sessionCookie(tenantId: string, auth: AuthConfig = TEST_AUTH): Promise<string> {
  return `${SESSION_COOKIE}=${await signSession(tenantId, auth.secret, auth.ttlSec)}`;
}

/**
 * The `Cookie` header for a session a response just minted - i.e. what a
 * browser would send next. Tests that go through `POST /cases` use this rather
 * than a hand-signed token, so the minting path is exercised too.
 */
export function cookieFrom(res: Response): string {
  const setCookie = res.headers.get("set-cookie");
  const pair = setCookie?.split(";")[0];
  if (!pair?.startsWith(`${SESSION_COOKIE}=`)) {
    throw new Error(`response did not set a ${SESSION_COOKIE} cookie`);
  }
  return pair;
}

/** What tests use. Hono's own `request` may return a Response synchronously. */
interface Requester {
  request(input: string, init?: RequestInit): Promise<Response>;
}
interface HonoLike {
  request(input: string, init?: RequestInit): Response | Promise<Response>;
}

/**
 * Wraps an app so every request carries a session, keeping call sites as
 * `app.request(path)`. A per-request `cookie` header still wins, which is how
 * cross-tenant tests present a *different* session.
 */
export function signedIn(app: HonoLike, cookie: string): Requester {
  return {
    async request(input, init) {
      const headers = new Headers(init?.headers);
      if (!headers.has("cookie")) headers.set("cookie", cookie);
      return app.request(input, { ...init, headers });
    },
  };
}
