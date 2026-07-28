import { check, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";

import { tenants } from "./tenants.js";

/** A case groups the documents of one evaluation (PRD FR-1.1: up to 10 docs). */
export const cases = pgTable(
  "cases",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    title: text().notNull(),
    /** `demo` marks a clone of the seeded template, which makes adoption idempotent. */
    origin: text({ enum: ["upload", "demo"] })
      .notNull()
      .default("upload"),
    retentionDays: integer().notNull().default(30),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The TS enum is compile-time only, and `demo/clone-case.ts` writes this
    // column in raw SQL - a CHECK is what actually holds the domain.
    check("cases_origin_check", sql`${t.origin} in ('upload', 'demo')`),
    // `POST /demo/adopt` is idempotent by a read-then-write check, which two
    // concurrent requests from the same session - a double-clicked button -
    // would both pass. This makes one demo clone per session structural
    // instead of hopeful; the route turns the conflict back into the 200.
    uniqueIndex("cases_one_demo_per_tenant")
      .on(t.tenantId)
      .where(sql`${t.origin} = 'demo'`),
  ],
);
