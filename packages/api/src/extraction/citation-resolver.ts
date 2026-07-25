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
 * Typographic folding for anchor matching (ADR-0009): unify the quote and dash
 * variants a model normalizes away. One code unit -> one code unit, so offsets
 * stay exact.
 */
const CHAR_FOLD: Record<string, string> = {
  "“": '"',
  "”": '"',
  "„": '"',
  "‟": '"',
  "«": '"',
  "»": '"',
  "″": '"',
  "‘": "'",
  "’": "'",
  "‚": "'",
  "‛": "'",
  "′": "'",
  "`": "'",
  "–": "-",
  "—": "-",
  "―": "-",
  "‑": "-",
  "−": "-",
};

const WHITESPACE = /\s/;

interface Normalized {
  norm: string;
  /** For each normalized char, the original [start,end) UTF-16 span it came from. */
  origStart: number[];
  origEnd: number[];
}

/**
 * A whitespace- and typography-invariant projection of `text` that still maps
 * every normalized char back to its exact original UTF-16 offsets. Any run of
 * Unicode whitespace (newlines, NBSP, repeated spaces — all artifacts of PDF/DOCX
 * layout frozen at parse time) collapses to one space; quote/dash variants fold.
 * A match found in `norm` therefore yields the exact original span, so ADR-0005
 * slice-identity holds even though the model's echoed anchor used plain spacing.
 */
function normalizeForMatch(text: string): Normalized {
  const norm: string[] = [];
  const origStart: number[] = [];
  const origEnd: number[] = [];
  let spaceRunStart = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (WHITESPACE.test(ch)) {
      if (spaceRunStart === -1) spaceRunStart = i;
      continue;
    }
    if (spaceRunStart !== -1) {
      norm.push(" ");
      origStart.push(spaceRunStart);
      origEnd.push(i);
      spaceRunStart = -1;
    }
    norm.push(CHAR_FOLD[ch] ?? ch);
    origStart.push(i);
    origEnd.push(i + 1);
  }
  if (spaceRunStart !== -1) {
    norm.push(" ");
    origStart.push(spaceRunStart);
    origEnd.push(text.length);
  }
  return { norm: norm.join(""), origStart, origEnd };
}

const normCache = new WeakMap<ClauseForCitation, Normalized>();
function normalizedClause(clause: ClauseForCitation): Normalized {
  let n = normCache.get(clause);
  if (!n) {
    n = normalizeForMatch(clause.text);
    normCache.set(clause, n);
  }
  return n;
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
 * Matching is whitespace- and typography-invariant (ADR-0009): the frozen text
 * keeps original PDF/DOCX spacing (line breaks, NBSP, doubled spaces) and quotes/
 * dashes, but a model echoes anchors with plain single spaces and straight
 * punctuation, so long spans failed an exact `includes`. Matching runs over a
 * normalized projection that maps back to the exact original offsets — invariance
 * to formatting, not fuzzy matching: it is still an exact substring match, and an
 * ambiguous anchor with no hint is still left unresolved.
 *
 * - anchor present: pick the clause whose normalized text contains it, preferring
 *   a hinted clause; with no usable hint, resolve only when it is unambiguous (a
 *   single containing clause) — never guess among several (ADR-0005).
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

  const normAnchor = anchor.length === 0 ? "" : normalizeForMatch(anchor).norm;

  if (normAnchor.length === 0) {
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
    const containing = [...clausesByRef.values()]
      .map((clause) => ({ clause, at: normalizedClause(clause).norm.indexOf(normAnchor) }))
      .filter((c) => c.at !== -1);
    const hintIds = new Set(hints.map((c) => c.id));
    const chosen =
      containing.find((c) => hintIds.has(c.clause.id)) ??
      (containing.length === 1 ? containing[0] : undefined);
    if (chosen) {
      const n = normalizedClause(chosen.clause);
      const start = n.origStart[chosen.at]!;
      const end = n.origEnd[chosen.at + normAnchor.length - 1]!;
      citations.push({
        clauseId: chosen.clause.id,
        charStart: chosen.clause.charStart + start,
        charEnd: chosen.clause.charStart + end,
        // The ORIGINAL frozen slice (ADR-0005), not the model's re-spaced anchor.
        verbatimAnchor: chosen.clause.text.slice(start, end),
      });
    }
  }

  // Report unresolved only when nothing grounded the field (the value survives).
  const unresolved = citations.length === 0 ? [...field.citations] : [];
  return { citations, unresolved };
}
