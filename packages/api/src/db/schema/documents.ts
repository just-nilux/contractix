import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { v7 as uuidv7 } from "uuid";

import { type ParseReport } from "@contractix/shared";

import { cases } from "./cases.js";

/** PRD FR-1.2 taxonomy. Null until the Phase-2 classifier runs (or demo seed backfills). */
export const documentTypeEnum = pgEnum("document_type", [
  "employment_offer",
  "employment_contract",
  "vsop_esop_agreement",
  "term_sheet",
  "shareholders_agreement",
  "side_letter",
  "other",
]);

export const documentStatusEnum = pgEnum("document_status", [
  "uploaded",
  "processing",
  "ready",
  "failed",
]);

export const languageEnum = pgEnum("language", ["de", "en", "mixed"]);

export const documents = pgTable(
  "documents",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    caseId: uuid()
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    // Denormalized so every query carries the FR-7.4 guard without a join.
    tenantId: uuid().notNull(),
    sha256: text().notNull(),
    filename: text().notNull(),
    mimeType: text().notNull(),
    byteSize: integer().notNull(),
    pageCount: integer(),
    language: languageEnum(),
    type: documentTypeEnum(),
    status: documentStatusEnum().notNull().default("uploaded"),
    parseReport: jsonb().$type<ParseReport>(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // FR-1.5 idempotent re-ingestion: same bytes in the same case = same document.
    uniqueIndex("documents_case_sha_uq").on(t.caseId, t.sha256),
    index("documents_tenant_idx").on(t.tenantId),
  ],
);
