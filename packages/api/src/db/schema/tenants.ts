import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { v7 as uuidv7 } from "uuid";

/**
 * Not multi-tenancy in the org/teams sense (PRD non-goal) - a tenant is a
 * single user account, an anonymous demo session, or the demo template. The
 * table exists so that FR-7.4's "single tenant_id guard in every query" has
 * something to guard.
 *
 * `kind`:
 * - `anon`  - one browser session's own scope. Expires; purged wholesale.
 * - `demo`  - the seeded corpus template. Never served directly, never expires;
 *             `POST /demo/adopt` clones it into an `anon` tenant so the guard
 *             stays a single equality check rather than a set membership.
 * - `user`  - a real account. None exist yet (accounts are not in v1).
 */
export const tenants = pgTable(
  "tenants",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    name: text().notNull(),
    kind: text({ enum: ["anon", "demo", "user"] })
      .notNull()
      .default("user"),
    /** FR-7.3: anonymous sessions are purged 24 h after they are minted. Null = never. */
    expiresAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("tenants_expires_idx")
      .on(t.expiresAt)
      .where(sql`${t.expiresAt} is not null`),
  ],
);
