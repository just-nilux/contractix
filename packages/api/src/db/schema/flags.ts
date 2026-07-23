import {
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { v7 as uuidv7 } from "uuid";

import { documents } from "./documents.js";

export const flagSeverityEnum = pgEnum("flag_severity", ["red", "amber", "info"]);

/**
 * A triggered benchmark rule (PRD FR-4, data model §8). Deterministic output of
 * the rules engine over a document's extraction: severity, the clause ids it
 * cites, and a snapshot of the rule's rationale/hint/sources at rule_version, so
 * a stored report stays reproducible even as the rule set evolves.
 */
export const flags = pgTable(
  "flags",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    documentId: uuid()
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    tenantId: uuid().notNull(),
    caseId: uuid().notNull(),
    ruleId: text().notNull(),
    ruleVersion: text().notNull(),
    severity: flagSeverityEnum().notNull(),
    clauseIds: uuid().array().notNull(),
    rationale: text().notNull(),
    negotiationHint: text(),
    sources: jsonb().$type<string[]>(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One row per (document, rule) — re-benchmarking replaces prior flags.
    uniqueIndex("flags_doc_rule_uq").on(t.documentId, t.ruleId),
    index("flags_tenant_idx").on(t.tenantId),
    index("flags_document_idx").on(t.documentId),
  ],
);
