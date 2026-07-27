import { boolean, index, integer, jsonb, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { v7 as uuidv7 } from "uuid";

import { cases } from "./cases.js";

/**
 * One answered question (PRD data model §8, FR-5.5). `traceJson` holds the
 * per-request tool calls, the clauses that were citable, the CRAG retry and the
 * validator verdict — it is what the FR-6.1 trace drawer renders, and the
 * reason retrieval decisions are auditable after the fact rather than only in
 * a log line.
 *
 * Token counts, cost and latency are persisted per turn because FR-8's budget
 * guard and the PRD's cost KPI need them per request, not aggregated.
 * `costEur` is numeric, not float: it is money, and it is summed.
 */
export const qaTurns = pgTable(
  "qa_turns",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid().notNull(),
    caseId: uuid()
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    question: text().notNull(),
    answer: text().notNull(),
    /** Model id, turns, tool steps, citable clause ids, stop reason. */
    traceJson: jsonb().notNull(),
    /** False when the validator could not tie every assertion to a clause. */
    grounded: boolean().notNull(),
    /** True when the answer came from the one corrective CRAG regeneration. */
    corrected: boolean().notNull(),
    /** Assertions returned with an explicit "could not verify" caveat (FR-5.2). */
    couldNotVerify: jsonb().notNull().default([]),
    inputTokens: integer().notNull(),
    outputTokens: integer().notNull(),
    costEur: numeric({ precision: 12, scale: 6 }).notNull(),
    latencyMs: integer().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("qa_turns_case_idx").on(t.caseId), index("qa_turns_tenant_idx").on(t.tenantId)],
);
