import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { v7 as uuidv7 } from "uuid";

import { tenants } from "./tenants.js";

export const users = pgTable("users", {
  id: uuid()
    .primaryKey()
    .$defaultFn(() => uuidv7()),
  tenantId: uuid()
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  email: text().notNull().unique(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});
