import { francAll } from "franc";

export type DocumentLanguage = "de" | "en" | "mixed";
export type ClauseLanguage = "de" | "en";

const FRANC_OPTS = { only: ["deu", "eng"] };
/**
 * Second-place score within this ratio of the top => genuinely mixed document.
 * Calibrated against franc's normalized trigram scores: clean monolingual
 * legal text puts the runner-up at ~0.72-0.76, a 50/50 document at ~0.99.
 */
const MIXED_RATIO = 0.9;
/** franc is unreliable below ~this many chars; fall back to the document language. */
const MIN_CHARS = 40;

function toLang(code: string): ClauseLanguage | null {
  if (code === "deu") return "de";
  if (code === "eng") return "en";
  return null;
}

export function detectDocumentLanguage(text: string): DocumentLanguage {
  const ranked = francAll(text, FRANC_OPTS);
  const top = ranked[0];
  const second = ranked[1];
  const topLang = top ? toLang(top[0]) : null;
  if (!topLang) return "de"; // German-market default for undetectable content
  if (second && top && second[1] / (top[1] || 1) > MIXED_RATIO) return "mixed";
  return topLang;
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
