import { clauseIdSchema } from "@contractix/shared";

/**
 * A clause a tool actually surfaced this request. Only these may be cited —
 * the model cannot cite a clause it never saw, and cannot cite one from another
 * case, because the citable set is built from tool output, not model output.
 */
export interface CitableClause {
  clauseId: string;
  serializedClauseId: string;
  documentId: string;
  page: number;
  charStart: number;
  charEnd: number;
  /** Frozen clause text — exactly the slice at [charStart, charEnd) (ADR-0005). */
  text: string;
}

export interface AnswerCitation {
  clauseId: string;
  serializedClauseId: string;
  documentId: string;
  page: number;
  charStart: number;
  charEnd: number;
  verbatimAnchor: string;
}

export interface AnswerSentence {
  text: string;
  markers: string[];
  /** Asserts something about the documents, so FR-5.2 requires a citation. */
  requiresCitation: boolean;
  cited: boolean;
  /** Flagged by the model as not derived from the documents (statute, context, caveat). */
  nonDocument: boolean;
}

export interface GroundingResult {
  ok: boolean;
  sentences: AnswerSentence[];
  /** How many sentences were declared non-document — the UI marks these visibly. */
  nonDocumentSentences: number;
  /** Assertions with no resolvable citation — the "could not verify" list. */
  uncited: string[];
  /** Markers that are malformed or name a clause no tool surfaced. */
  unresolvedMarkers: string[];
  citations: AnswerCitation[];
}

const MARKER_RE = /\[\[([^[\]]+)\]\]/gu;
/**
 * Sentence splitting masks markers first, so a clause path containing '.' or
 * '/' can never be read as a sentence boundary. The placeholder is delimited by
 * control characters that cannot appear in an answer, so a document phrase like
 * "Anlage M1" can never be mistaken for one.
 */
const MASK_START = "\u0001";
const MASK_END = "\u0002";
const MASK_RE = new RegExp(`${MASK_START}(\\d+)${MASK_END}`, "gu");
const maskFor = (index: number): string => `${MASK_START}${index}${MASK_END}`;

/**
 * German and English abbreviations whose trailing period is not a sentence end.
 * `§ 3 Abs. 2` and `z.B.` are ordinary in this corpus, and splitting there would
 * manufacture uncited fragments out of a properly cited sentence.
 */
const ABBREVIATIONS = new Set([
  "abs",
  "art",
  "bzw",
  "ca",
  "cf",
  "d.h",
  "e.g",
  "etc",
  "evtl",
  "ggf",
  "i.d.r",
  "i.e",
  "inkl",
  "insb",
  "mio",
  "mrd",
  "nr",
  "no",
  "para",
  "sec",
  "sog",
  "u.a",
  "usw",
  "vgl",
  "vs",
  "z.b",
  "ziff",
]);

export function extractMarkers(text: string): string[] {
  return [...text.matchAll(MARKER_RE)].map((m) => m[1]!.trim());
}

/**
 * Split an answer into sentences. Markers are masked first so a clause path
 * like `anlage-1/2.1` can never be read as a sentence boundary.
 */
export function splitSentences(answer: string): string[] {
  const markers: string[] = [];
  const masked = answer.replace(MARKER_RE, (whole) => {
    markers.push(whole);
    return maskFor(markers.length - 1);
  });

  // Split on every line break, not just blank lines: answers are Markdown, and
  // a heading glued to the sentence under it produced a bogus "uncited" chunk.
  const parts = masked
    .split(/\n+/u)
    .flatMap((line) => line.split(/(?<=[.!?])\s+(?=[^\s])/u))
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const merged: string[] = [];
  for (const part of parts) {
    const prev = merged.at(-1);
    // Re-join a fragment split after an abbreviation or a bare numeric label,
    // and absorb a trailing marker-only fragment: "Sentence. [[id]]" cites the
    // sentence, it is not a separate uncited claim followed by a stray id.
    if (prev !== undefined && (endsWithAbbreviation(prev) || isMarkerOnly(part))) {
      merged[merged.length - 1] = `${prev} ${part}`;
    } else {
      merged.push(part);
    }
  }

  return merged.map((s) => s.replace(MASK_RE, (_m, i: string) => markers[Number(i)]!));
}

/**
 * Reserved markers for a sentence that is deliberately *not* a claim about the
 * documents: a statutory reference (`[[statute:§74 HGB]]`), market context, or
 * the model's own caveat.
 *
 * Without this the contract systematically fails correct answers — a live run
 * flagged both "§74 HGB requires 50%, which is not in the document" and "this is
 * not a conclusive legal assessment", burning the corrective retry each time.
 * Statutory pointers and caveats are things the PRD actively wants (FR-7.6,
 * and the rules engine already carries `sources` like ["§74 HGB"]), so the fix
 * is to give the model a way to declare them rather than to loosen the check.
 *
 * This is weaker than a clause citation by design, and deliberately visible: the
 * count is reported so the UI can render these sentences as "not from your
 * documents" instead of letting them pass as sourced.
 */
const NON_DOCUMENT_MARKER_RE = /^(?:statute|context|caveat)\b/iu;

function isNonDocumentMarker(marker: string): boolean {
  return NON_DOCUMENT_MARKER_RE.test(marker.trim());
}

/** A fragment that is nothing but citation markers and punctuation. */
function isMarkerOnly(fragment: string): boolean {
  const withoutMasks = fragment.replace(MASK_RE, " ");
  if (withoutMasks === fragment) return false;
  return !/[\p{L}\p{N}]/u.test(withoutMasks);
}

function endsWithAbbreviation(sentence: string): boolean {
  const match = /(\S+)\.$/u.exec(sentence.trimEnd());
  if (!match) return false;
  const token = match[1]!;
  // "§ 3." / "2." — a numbered label, not a sentence end.
  if (/^\d+$/u.test(token)) return true;
  if (ABBREVIATIONS.has(token.toLowerCase())) return true;
  // A standalone initial ("J."), but never a digit-glued token: "1x." ends a
  // sentence, and 1x/2x liquidation preferences are everywhere in this corpus.
  return /^\p{L}$/u.test(token);
}

/**
 * Whether a sentence asserts something that must be cited.
 *
 * Deliberately strict, because a hallucinated term is this product's worst
 * failure mode (PRD §11): anything containing letters is treated as an
 * assertion. The only exemption is a lead-in ending in ':' , which asserts
 * nothing on its own and whose list items carry their own citations.
 */
export function requiresCitation(sentence: string): boolean {
  const withoutMarkers = sentence.replace(MARKER_RE, " ").trim();
  if (!/\p{L}/u.test(withoutMarkers)) return false;
  // A lead-in asserts nothing on its own; its list items carry their own cites.
  if (withoutMarkers.endsWith(":")) return false;
  return !isHeading(withoutMarkers);
}

/**
 * A Markdown heading or short bold label — structure, not a claim. Bounded by
 * length and by the absence of sentence-ending punctuation so that a real
 * assertion cannot escape the contract just by being bold.
 */
const MAX_HEADING_CHARS = 60;

function isHeading(text: string): boolean {
  const stripped = text
    .replace(/^#{1,6}\s+/u, "")
    .replace(/^[-*+]\s+/u, "")
    .trim();

  if (/^#{1,6}\s/u.test(text)) {
    return !/[.!?]$/u.test(stripped) && stripped.length <= MAX_HEADING_CHARS;
  }

  const bold = /^\*\*(.+)\*\*$/su.exec(stripped);
  if (!bold) return false;
  // Test the text inside the emphasis: "**...Monate.**" ends in '**', so
  // checking the outer string would let a full sentence pass as a label.
  const inner = bold[1]!.trim();
  return !/[.!?]$/u.test(inner) && inner.length <= MAX_HEADING_CHARS;
}

/**
 * Enforce the FR-5.2 grounding contract over a generated answer.
 *
 * Resolution is purely structural (ADR-0005/0007): a marker resolves by naming
 * a clause in the citable set, and the stored span is that clause's frozen
 * offsets. Nothing is ever quote-matched against the answer text, so the model
 * cannot talk its way into a citation by paraphrasing a clause convincingly.
 */
export function validateGrounding(answer: string, citable: CitableClause[]): GroundingResult {
  const byId = new Map(citable.map((c) => [c.serializedClauseId, c]));
  const sentences: AnswerSentence[] = [];
  const uncited: string[] = [];
  const unresolvedMarkers: string[] = [];
  const cited = new Map<string, AnswerCitation>();
  let nonDocument = 0;

  for (const text of splitSentences(answer)) {
    const markers = extractMarkers(text);
    let resolvedHere = 0;

    let nonDocumentHere = 0;

    for (const marker of markers) {
      if (isNonDocumentMarker(marker)) {
        nonDocumentHere++;
        continue;
      }
      if (!clauseIdSchema.safeParse(marker).success) {
        unresolvedMarkers.push(marker);
        continue;
      }
      const clause = byId.get(marker);
      if (!clause) {
        unresolvedMarkers.push(marker);
        continue;
      }
      resolvedHere++;
      cited.set(marker, {
        clauseId: clause.clauseId,
        serializedClauseId: clause.serializedClauseId,
        documentId: clause.documentId,
        page: clause.page,
        charStart: clause.charStart,
        charEnd: clause.charEnd,
        // The clause text IS the slice at those offsets, so the write-time
        // anchor invariant holds by construction.
        verbatimAnchor: clause.text,
      });
    }

    const needed = requiresCitation(text);
    const isCited = resolvedHere > 0;
    if (nonDocumentHere > 0) nonDocument++;
    // A sentence the model flagged as not-from-the-documents satisfies the
    // contract without a clause: it makes no claim about the documents.
    if (needed && !isCited && nonDocumentHere === 0) uncited.push(text);
    sentences.push({
      text,
      markers,
      requiresCitation: needed,
      cited: isCited,
      nonDocument: nonDocumentHere > 0,
    });
  }

  return {
    ok: uncited.length === 0 && unresolvedMarkers.length === 0,
    sentences,
    nonDocumentSentences: nonDocument,
    uncited,
    unresolvedMarkers,
    citations: [...cited.values()],
  };
}

/**
 * The critique fed back for the single corrective regeneration (CRAG). Names
 * the exact failures rather than asking for a vague retry, and re-states the
 * only legal citation ids so the model cannot invent another one.
 */
export function buildCritique(result: GroundingResult, citable: CitableClause[]): string {
  const lines: string[] = [
    "Your previous answer did not satisfy the grounding contract.",
    "",
    // Without this the model replies conversationally ("Thanks — here is the
    // corrected version"), and that acknowledgement is itself an uncited
    // sentence, so the retry fails on an artefact of the critique.
    "Reply with the corrected answer and nothing else: no acknowledgement, no preamble, " +
      "no description of what you changed. The user sees only your answer, not this message.",
  ];
  if (result.uncited.length > 0) {
    lines.push(
      "",
      "These sentences assert something about the documents but carry no citation. " +
        "Either cite a clause id for each, or delete the claim:",
      ...result.uncited.map((s) => `- ${s}`),
    );
  }
  if (result.unresolvedMarkers.length > 0) {
    lines.push(
      "",
      "These citation ids do not exist in the retrieved clauses. Never invent an id — " +
        "retrieve the clause first, then cite the id exactly as returned:",
      ...result.unresolvedMarkers.map((m) => `- [[${m}]]`),
    );
  }
  lines.push(
    "",
    "If a sentence is genuinely not about the documents — a statutory reference, market " +
      "context, or your own caveat — mark it [[statute:...]], [[context:...]] or [[caveat]] " +
      "rather than deleting it.",
  );
  lines.push(
    "",
    "The only citation ids you may use are:",
    ...citable.map((c) => `- ${c.serializedClauseId}`),
  );
  return lines.join("\n");
}
