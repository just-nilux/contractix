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

/** Enum values mirror the shared Zod schemas (schemas/extraction/field.ts). */
export const extractionConfidenceEnum = pgEnum("extraction_confidence", ["high", "medium", "low"]);
export const extractionStatusEnum = pgEnum("extraction_status", [
  "extracted",
  "not_found",
  "extraction_failed",
]);

/**
 * One row per extracted field (PRD FR-3, data model §8). The typed value lives
 * in `value` (jsonb; null for not_found); the clause spans that support it live
 * in `citations`. tenant/case ids are denormalized so every read carries the
 * FR-7.4 guard without a join.
 */
export const extractions = pgTable(
  "extractions",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    documentId: uuid()
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    tenantId: uuid().notNull(),
    caseId: uuid().notNull(),
    /** e.g. "employment@1" — the family schema version this row was produced by. */
    schemaVer: text().notNull(),
    /** e.g. "non_compete" — the field key within the family schema. */
    fieldPath: text().notNull(),
    value: jsonb().$type<unknown>(),
    unit: text(),
    confidence: extractionConfidenceEnum().notNull(),
    status: extractionStatusEnum().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Idempotent re-extraction: one row per (document, schema version, field).
    uniqueIndex("extractions_doc_field_uq").on(t.documentId, t.schemaVer, t.fieldPath),
    index("extractions_tenant_idx").on(t.tenantId),
    index("extractions_document_idx").on(t.documentId),
  ],
);
