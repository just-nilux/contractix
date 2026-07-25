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
 * and ANCHOR-FIRST (ADR-0007): the clause whose frozen text contains the exact
 * `verbatim_anchor` IS the citation. The model's clause ids are treated as
 * hints (to disambiguate a repeated anchor), never trusted for their format — a
 * small model rarely reproduces the long `{uuid}:{page}:{path}` id verbatim, so
 * binding resolution to it (the original design) silently dropped good citations
 * and, upstream, a strict id schema failed the whole extraction.
 *
 * - anchor present: pick the clause containing it, preferring a hinted clause;
 *   with no usable hint, resolve only when the anchor is unambiguous (a single
 *   containing clause) — never guess among several (ADR-0005: no fuzzy matching).
 * - anchor empty: cite the whole span of each hinted clause.
 * - nothing grounded: the model's citations are returned as `unresolved` (for the
 *   Phase-3 "could not verify" path); an extracted value keeps its value and the
 *   caller downgrades confidence.
 */
export function resolveFieldCitations(
  field: Pick<CitedFieldValue, "citations" | "verbatim_anchor">,
  clausesByRef: Map<string, ClauseForCitation>,
  documentId: string,
): ResolvedField {
  const anchor = field.verbatim_anchor.trim();
  const citations: ResolvedCitation[] = [];

  // Parse the model's cited ids leniently into clauses in THIS document. A
  // malformed or foreign id simply does not become a hint — it never throws the
  // whole field away, and anchor matching below can still ground the value.
  const hints: ClauseForCitation[] = [];
  for (const serialized of field.citations) {
    let ref: string | null = null;
    try {
      const parsed = parseClauseId(serialized);
      if (parsed.documentId === documentId) ref = parsed.clauseRef;
    } catch {
      ref = null;
    }
    const clause = ref ? clausesByRef.get(ref) : undefined;
    if (clause) hints.push(clause);
  }

  if (anchor.length === 0) {
    // No anchor to locate — cite the whole span of each hinted clause.
    for (const clause of hints) {
      citations.push({
        clauseId: clause.id,
        charStart: clause.charStart,
        charEnd: clause.charEnd,
        verbatimAnchor: clause.text,
      });
    }
  } else {
    const containing = [...clausesByRef.values()].filter((c) => c.text.includes(anchor));
    const hintIds = new Set(hints.map((c) => c.id));
    const chosen =
      containing.find((c) => hintIds.has(c.id)) ??
      (containing.length === 1 ? containing[0] : undefined);
    if (chosen) {
      const idx = chosen.text.indexOf(anchor);
      citations.push({
        clauseId: chosen.id,
        charStart: chosen.charStart + idx,
        charEnd: chosen.charStart + idx + anchor.length,
        verbatimAnchor: anchor,
      });
    }
  }

  // Report unresolved only when nothing grounded the field (the value survives).
  const unresolved = citations.length === 0 ? [...field.citations] : [];
  return { citations, unresolved };
}
