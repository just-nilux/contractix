import { describe, expect, it } from "vitest";

import {
  buildCritique,
  type CitableClause,
  extractMarkers,
  requiresCitation,
  splitSentences,
  validateGrounding,
} from "./grounding.js";

const DOC_A = "6a2f1c3e-4b5d-4e6f-8a9b-0c1d2e3f4a5b";
const DOC_B = "7b3e2d4f-5c6e-4f70-9bac-1d2e3f4a5b6c";

function clause(documentId: string, ref: string, text: string, at = 100): CitableClause {
  return {
    clauseId: `${documentId}-${ref}`,
    serializedClauseId: `${documentId}:${ref}`,
    documentId,
    page: Number(ref.split(":")[0]),
    charStart: at,
    charEnd: at + text.length,
    text,
  };
}

const PROBEZEIT = clause(DOC_A, "2:§3", "Die Probezeit beträgt sechs Monate.");
const KARENZ = clause(DOC_A, "4:§11", "Eine Karenzentschädigung wird nicht gezahlt.", 900);
const CITABLE = [PROBEZEIT, KARENZ];

const id = (c: CitableClause) => c.serializedClauseId;

describe("extractMarkers", () => {
  it("pulls ids out of [[...]] markers", () => {
    expect(extractMarkers(`Text [[${id(PROBEZEIT)}]] and [[${id(KARENZ)}]].`)).toEqual([
      id(PROBEZEIT),
      id(KARENZ),
    ]);
    expect(extractMarkers("no markers here")).toEqual([]);
  });
});

describe("splitSentences", () => {
  it("does not split inside a citation marker", () => {
    // Clause paths legitimately contain dots and slashes.
    const answer = `Vesting läuft über vier Jahre [[${DOC_A}:3:anlage-1/2.1]]. Danach endet es.`;
    const parts = splitSentences(answer);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toContain(`[[${DOC_A}:3:anlage-1/2.1]]`);
  });

  it("does not split on German legal abbreviations", () => {
    expect(splitSentences("Vgl. § 3 Abs. 2 der Vereinbarung.")).toEqual([
      "Vgl. § 3 Abs. 2 der Vereinbarung.",
    ]);
    expect(splitSentences("Das gilt z.B. für Nr. 4 des Vertrags.")).toEqual([
      "Das gilt z.B. für Nr. 4 des Vertrags.",
    ]);
  });

  it("splits ordinary prose in both languages", () => {
    expect(splitSentences("Die Probezeit ist sechs Monate. Das ist zulässig.")).toHaveLength(2);
    expect(splitSentences("The preference is 1x. It is non-participating.")).toHaveLength(2);
  });
});

describe("requiresCitation", () => {
  it("treats assertions as citable and exempts lead-ins", () => {
    expect(requiresCitation("Die Probezeit beträgt sechs Monate.")).toBe(true);
    expect(requiresCitation("Zusammenfassung der wesentlichen Punkte:")).toBe(false);
    expect(requiresCitation("   ")).toBe(false);
    expect(requiresCitation("---")).toBe(false);
  });

  it("does not let a bare marker count as non-assertive", () => {
    expect(requiresCitation(`Sechs Monate [[${id(PROBEZEIT)}]].`)).toBe(true);
  });
});

describe("validateGrounding", () => {
  it("accepts an answer whose every assertion cites a retrieved clause", () => {
    const answer =
      `Die Probezeit beträgt sechs Monate [[${id(PROBEZEIT)}]]. ` +
      `Eine Karenzentschädigung ist nicht vorgesehen [[${id(KARENZ)}]].`;
    const res = validateGrounding(answer, CITABLE);

    expect(res.ok).toBe(true);
    expect(res.uncited).toEqual([]);
    expect(res.unresolvedMarkers).toEqual([]);
    expect(res.citations).toHaveLength(2);
  });

  it("flags an assertion carrying no citation", () => {
    const answer =
      `Die Probezeit beträgt sechs Monate [[${id(PROBEZEIT)}]]. ` +
      "Das Gehalt steigt jährlich um 5%.";
    const res = validateGrounding(answer, CITABLE);

    expect(res.ok).toBe(false);
    expect(res.uncited).toEqual(["Das Gehalt steigt jährlich um 5%."]);
    expect(res.citations).toHaveLength(1);
  });

  /** The hallucination this whole mechanism exists to catch. */
  it("rejects a well-formed id for a clause no tool returned", () => {
    const invented = `${DOC_B}:9:§99`;
    const res = validateGrounding(`Es gilt eine Sperrfrist [[${invented}]].`, CITABLE);

    expect(res.ok).toBe(false);
    expect(res.unresolvedMarkers).toEqual([invented]);
    expect(res.citations).toEqual([]);
    // The sentence is also uncited: an unresolvable marker is not a citation.
    expect(res.uncited).toHaveLength(1);
  });

  it("rejects a malformed id", () => {
    const res = validateGrounding("Etwas gilt [[not-a-clause-id]].", CITABLE);
    expect(res.ok).toBe(false);
    expect(res.unresolvedMarkers).toEqual(["not-a-clause-id"]);
  });

  it("resolves structurally to frozen offsets, never by quote-matching", () => {
    // The answer paraphrases; the stored span is still the clause's own offsets.
    const res = validateGrounding(`Probezeit: ein halbes Jahr [[${id(PROBEZEIT)}]].`, CITABLE);
    expect(res.citations[0]).toEqual({
      clauseId: PROBEZEIT.clauseId,
      serializedClauseId: PROBEZEIT.serializedClauseId,
      documentId: DOC_A,
      page: 2,
      charStart: PROBEZEIT.charStart,
      charEnd: PROBEZEIT.charEnd,
      verbatimAnchor: PROBEZEIT.text,
    });
  });

  it("dedupes a clause cited by several sentences", () => {
    const answer = `Sechs Monate [[${id(PROBEZEIT)}]]. Das ist die gesetzliche Obergrenze [[${id(PROBEZEIT)}]].`;
    expect(validateGrounding(answer, CITABLE).citations).toHaveLength(1);
  });

  it("treats an empty answer as ungrounded but not as a citation failure", () => {
    const res = validateGrounding("", CITABLE);
    expect(res.sentences).toEqual([]);
    expect(res.citations).toEqual([]);
    expect(res.ok).toBe(true);
  });
});

describe("buildCritique", () => {
  it("names the exact failures and the only legal ids", () => {
    const invented = `${DOC_B}:9:§99`;
    const res = validateGrounding(
      `Das Gehalt steigt jährlich. Es gibt eine Sperrfrist [[${invented}]].`,
      CITABLE,
    );
    const critique = buildCritique(res, CITABLE);

    expect(critique).toContain("Das Gehalt steigt jährlich.");
    expect(critique).toContain(invented);
    expect(critique).toContain(id(PROBEZEIT));
    expect(critique).toContain(id(KARENZ));
  });
});
