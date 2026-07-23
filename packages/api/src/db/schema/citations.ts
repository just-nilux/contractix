import { index, integer, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { v7 as uuidv7 } from "uuid";

import { clauses } from "./clauses.js";
import { extractions } from "./extractions.js";

export const citationSourceEnum = pgEnum("citation_source", ["extraction", "answer"]);

/**
 * A structural citation (ADR-0005): a resolved span inside a clause. char_start/
 * char_end are absolute canonical offsets, and verbatim_anchor is the exact text
 * the clause slice yields at those offsets — validated at write time, never
 * quote-matched after the fact. `answer` citations (Phase-3 Q&A) reuse the same
 * table; extraction citations link to their extraction row.
 */
export const citations = pgTable(
  "citations",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid().notNull(),
    documentId: uuid().notNull(),
    sourceType: citationSourceEnum().notNull(),
    extractionId: uuid().references(() => extractions.id, { onDelete: "cascade" }),
    clauseId: uuid()
      .notNull()
      .references(() => clauses.id, { onDelete: "cascade" }),
    charStart: integer().notNull(),
    charEnd: integer().notNull(),
    verbatimAnchor: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("citations_extraction_idx").on(t.extractionId),
    index("citations_clause_idx").on(t.clauseId),
    index("citations_tenant_idx").on(t.tenantId),
  ],
);
