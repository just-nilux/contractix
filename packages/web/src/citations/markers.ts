/**
 * Splits generated prose on its `[[...]]` citation markers.
 *
 * The grounding contract (ADR-0010) makes every factual sentence carry at least
 * one marker, so the raw markdown is dense with them and unreadable as-is. This
 * turns each into something the reader can act on, and - importantly - keeps the
 * three non-document marker kinds visibly distinct: a `[[statute:...]]`,
 * `[[context:...]]` or `[[caveat]]` is the model saying "this next part is not
 * from your documents", and collapsing it into an ordinary citation would erase
 * exactly the distinction it was asked to draw.
 *
 * An unmatched marker is left as literal text rather than dropped. A marker the
 * validator let through but this cannot resolve is a bug worth seeing, and
 * silently deleting it would hide it.
 */
const MARKER = /\[\[([^\]]+)\]\]/g;

export type MarkerKind = "clause" | "statute" | "context" | "caveat";

export interface ClauseMarkerPart {
  type: "marker";
  kind: MarkerKind;
  /** The raw marker body: a serialized clause id, or the text after `statute:`. */
  value: string;
  /** Present only when a citation with this serialized id was supplied. */
  citationIndex: number | null;
}

export interface TextPart {
  type: "text";
  value: string;
}

export type MarkdownPart = TextPart | ClauseMarkerPart;

function classify(body: string): { kind: MarkerKind; value: string } {
  if (body === "caveat") return { kind: "caveat", value: "" };
  if (body.startsWith("statute:")) return { kind: "statute", value: body.slice(8).trim() };
  if (body.startsWith("context:")) return { kind: "context", value: body.slice(8).trim() };
  return { kind: "clause", value: body };
}

/**
 * @param serializedIds the citations' serialized clause ids, in the order the
 *   caller holds them - the returned `citationIndex` points back into that list.
 */
export function splitMarkers(text: string, serializedIds: readonly string[]): MarkdownPart[] {
  const index = new Map(serializedIds.map((id, i) => [id, i]));
  const parts: MarkdownPart[] = [];
  let cursor = 0;

  for (const match of text.matchAll(MARKER)) {
    const at = match.index;
    const body = match[1];
    if (body === undefined) continue;

    if (at > cursor) parts.push({ type: "text", value: text.slice(cursor, at) });

    const { kind, value } = classify(body.trim());
    parts.push({
      type: "marker",
      kind,
      value,
      citationIndex: kind === "clause" ? (index.get(value) ?? null) : null,
    });
    cursor = at + match[0].length;
  }

  if (cursor < text.length) parts.push({ type: "text", value: text.slice(cursor) });
  return parts;
}

/** True when the text contains at least one marker. */
export function hasMarkers(text: string): boolean {
  return /\[\[[^\]]+\]\]/.test(text);
}
