import { z } from "zod";

/**
 * Stable clause identity (PRD FR-1.3: `doc:page:clause_path`).
 *
 * Inside the database a clause row has a uuid PK; the PRD's stable ID is kept
 * as a natural key `clause_ref = "{page}:{clause_path}"`, unique per document.
 * The fully-qualified serialized form `${documentId}:${clauseRef}` is what
 * API responses and (later) `[[clause_id]]` citation markers carry.
 *
 * `clause_path` never contains `:` or whitespace - `/` separates numbering
 * scopes (e.g. `anlage-1/2.1`).
 */
export const clausePathSchema = z
  .string()
  .min(1)
  .regex(/^[^:\s]+$/, "clause_path must not contain ':' or whitespace");

export const clauseRefSchema = z
  .string()
  .regex(/^\d+:[^:\s]+$/, "clause_ref must be '{page}:{clause_path}'");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function buildClauseRef(page: number, clausePath: string): string {
  if (!Number.isInteger(page) || page < 1) {
    throw new Error(`invalid page for clause_ref: ${page}`);
  }
  clausePathSchema.parse(clausePath);
  return `${page}:${clausePath}`;
}

export function serializeClauseId(documentId: string, clauseRef: string): string {
  if (!UUID_RE.test(documentId)) {
    throw new Error(`invalid document id: ${documentId}`);
  }
  clauseRefSchema.parse(clauseRef);
  return `${documentId}:${clauseRef}`;
}

export interface ParsedClauseId {
  documentId: string;
  page: number;
  clausePath: string;
  clauseRef: string;
}

export function parseClauseId(serialized: string): ParsedClauseId {
  const first = serialized.indexOf(":");
  const second = serialized.indexOf(":", first + 1);
  if (first === -1 || second === -1) {
    throw new Error(`malformed clause id: ${serialized}`);
  }
  const documentId = serialized.slice(0, first);
  const pageRaw = serialized.slice(first + 1, second);
  const clausePath = serialized.slice(second + 1);
  if (!UUID_RE.test(documentId)) {
    throw new Error(`malformed clause id (document uuid): ${serialized}`);
  }
  const page = Number(pageRaw);
  if (!Number.isInteger(page) || page < 1) {
    throw new Error(`malformed clause id (page): ${serialized}`);
  }
  clausePathSchema.parse(clausePath);
  return { documentId, page, clausePath, clauseRef: `${page}:${clausePath}` };
}
