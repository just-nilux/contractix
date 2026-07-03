import { franc, francAll } from "franc";

export type DocumentLanguage = "de" | "en" | "mixed";
export type ClauseLanguage = "de" | "en";

const FRANC_OPTS = { only: ["deu", "eng"] };
/** franc is unreliable below ~this many chars; fall back to the document language. */
const MIN_CHARS = 40;
/** Units per language side for a document to count as genuinely mixed. */
const MIXED_MINORITY_SHARE = 0.25;
const MIN_UNIT_CHARS = 60;

function toLang(code: string): ClauseLanguage | null {
  if (code === "deu") return "de";
  if (code === "eng") return "en";
  return null;
}

/**
 * Whole-document trigram ratios saturate on long legal text (the runner-up
 * scores 0.95+ even on clean monolingual contracts - measured on the corpus).
 * Instead: classify paragraph-sized units independently and call the document
 * mixed only when a substantial minority (>=25%) of units is the other
 * language - which is what "mixed" means for retrieval (FR-1.3).
 */
export function detectDocumentLanguage(text: string): DocumentLanguage {
  const units = text.split("\n").filter((u) => u.trim().length >= MIN_UNIT_CHARS);

  let de = 0;
  let en = 0;
  for (const unit of units) {
    const lang = toLang(franc(unit, FRANC_OPTS));
    if (lang === "de") de++;
    else if (lang === "en") en++;
  }

  const total = de + en;
  if (total < 3) {
    // Too little signal for voting: fall back to whole-text top-1.
    const top = francAll(text, FRANC_OPTS)[0];
    return (top && toLang(top[0])) ?? "de";
  }

  const minority = Math.min(de, en);
  if (minority / total >= MIXED_MINORITY_SHARE) return "mixed";
  return de >= en ? "de" : "en";
}

/**
 * Chunks need a strict binary language (the tsvector config is german|english).
 * Mixed documents re-detect per clause; short clauses inherit the document's
 * dominant side.
 */
export function detectClauseLanguage(text: string, docLanguage: DocumentLanguage): ClauseLanguage {
  const fallback: ClauseLanguage = docLanguage === "en" ? "en" : "de";
  if (text.length < MIN_CHARS) return fallback;
  if (docLanguage !== "mixed") return fallback;
  const top = francAll(text, FRANC_OPTS)[0];
  return (top && toLang(top[0])) ?? fallback;
}
