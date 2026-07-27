import { integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { v7 as uuidv7 } from "uuid";

import { tenants } from "./tenants.js";

/** A case groups the documents of one evaluation (PRD FR-1.1: up to 10 docs). */
export const cases = pgTable("cases", {
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
});
