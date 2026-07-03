/**
 * THE only module allowed to transform text (ADR-0005). Everything here runs
 * BEFORE offsets are frozen; downstream stages may only slice canonical text.
 */

/** NFKC folds ligature codepoints (ﬁ -> fi) that PDF text layers love to emit. */
export function normalizeText(raw: string): string {
  return raw
    .normalize("NFKC")
    .replaceAll("\u00AD", "") // soft hyphen: purely typographic
    .replaceAll(/[\t\p{Zs}]+/gu, " ") // every space separator (nbsp, thin space, ...) -> plain space
    .trim();
}

// trailing hyphen-minus, U+2010 hyphen, or U+2011 non-breaking hyphen
const DEHYPHEN_RE = /[-‐‑]$/;

/**
 * Join physical lines into block text, undoing end-of-line hyphenation.
 * Heuristic: a line ending in a hyphen followed by a line starting lowercase
 * is a broken word ("Kündigungs-" + "frist" -> "Kündigungsfrist"); anything
 * else keeps the hyphen and joins with a space. Documented limitation: a
 * genuinely hyphenated compound broken exactly at the hyphen loses it.
 */
export function joinLinesWithDehyphenation(lines: readonly string[]): string {
  let out = "";
  for (const line of lines) {
    const piece = line.trim();
    if (piece.length === 0) continue;
    if (out.length === 0) {
      out = piece;
      continue;
    }
    if (DEHYPHEN_RE.test(out) && /^[a-zäöüß]/.test(piece)) {
      out = out.replace(DEHYPHEN_RE, "") + piece;
    } else {
      out = `${out} ${piece}`;
    }
  }
  return out;
}
