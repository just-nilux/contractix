import { type CitedFieldValue, parseClauseId } from "@contractix/shared";

/** The minimal clause shape the resolver needs — the frozen slice + its offsets. */
export interface ClauseForCitation {
  id: string;
  clauseRef: string;
  charStart: number;
  charEnd: number;
  text: string;
}

export interface ResolvedCitation {
  clauseId: string;
  charStart: number;
  charEnd: number;
  verbatimAnchor: string;
}

export interface ResolvedField {
  citations: ResolvedCitation[];
  /** Serialized clause ids the model cited that could not be resolved structurally. */
  unresolved: string[];
}

/**
 * Resolve a field's citations to concrete clause spans (ADR-0005), structurally
 * — never by fuzzy quote-matching. For each cited clause id we locate the
 * verbatim anchor inside that clause's frozen text and emit absolute canonical
 * offsets; an anchor that does not slice from the named clause is unresolved
 * (a likely hallucinated citation). An empty anchor cites the whole clause span.
 */
export function resolveFieldCitations(
  field: Pick<CitedFieldValue, "citations" | "verbatim_anchor">,
  clausesByRef: Map<string, ClauseForCitation>,
  documentId: string,
): ResolvedField {
  const citations: ResolvedCitation[] = [];
  const unresolved: string[] = [];
  const anchor = field.verbatim_anchor.trim();

  for (const serialized of field.citations) {
    let parsed;
    try {
      parsed = parseClauseId(serialized);
    } catch {
      unresolved.push(serialized);
      continue;
    }
    if (parsed.documentId !== documentId) {
      unresolved.push(serialized);
      continue;
    }
    const clause = clausesByRef.get(parsed.clauseRef);
    if (!clause) {
      unresolved.push(serialized);
      continue;
    }

    if (anchor.length === 0) {
      citations.push({
        clauseId: clause.id,
        charStart: clause.charStart,
        charEnd: clause.charEnd,
        verbatimAnchor: clause.text,
      });
      continue;
    }

    const idx = clause.text.indexOf(anchor);
    if (idx < 0) {
      unresolved.push(serialized);
      continue;
    }
    citations.push({
      clauseId: clause.id,
      charStart: clause.charStart + idx,
      charEnd: clause.charStart + idx + anchor.length,
      verbatimAnchor: anchor,
    });
  }

  return { citations, unresolved };
}
