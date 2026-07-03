import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { v7 as uuidv7 } from "uuid";

/**
 * Not multi-tenancy in the org/teams sense (PRD non-goal) - a tenant is a
 * single user account or the anonymous demo tenant. The table exists so that
 * FR-7.4's "single tenant_id guard in every query" has something to guard.
 */
export const tenants = pgTable("tenants", {
  id: uuid()
    .primaryKey()
    .$defaultFn(() => uuidv7()),
  name: text().notNull(),
  kind: text({ enum: ["demo", "user"] })
    .notNull()
    .default("user"),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});
