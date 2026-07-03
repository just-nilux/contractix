import { index, integer, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { v7 as uuidv7 } from "uuid";

import { documents } from "./documents.js";

/**
 * A clause is the citation unit (ADR-0005): stable natural key
 * clause_ref = "{page}:{clause_path}" unique per document; char offsets are
 * frozen absolute positions in the document's canonical text.
 */
export const clauses = pgTable(
  "clauses",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    documentId: uuid()
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    tenantId: uuid().notNull(),
    clauseRef: text().notNull(),
    clausePath: text().notNull(),
    heading: text(),
    headingPath: text().array().notNull(),
    page: integer().notNull(),
    charStart: integer().notNull(),
    charEnd: integer().notNull(),
    text: text().notNull(),
    seq: integer().notNull(),
  },
  (t) => [
    uniqueIndex("clauses_doc_ref_uq").on(t.documentId, t.clauseRef),
    index("clauses_doc_seq_idx").on(t.documentId, t.seq),
    index("clauses_tenant_idx").on(t.tenantId),
  ],
);
