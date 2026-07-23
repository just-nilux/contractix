import { describe, expect, it } from "vitest";

import { buildClauseRef, clauseIdSchema, parseClauseId, serializeClauseId } from "./ids.js";

const DOC_ID = "0197a3b2-1c4d-7e5f-8a9b-0c1d2e3f4a5b";

describe("clause ref helpers", () => {
  it("builds refs as page:clause_path", () => {
    expect(buildClauseRef(3, "§4")).toBe("3:§4");
    expect(buildClauseRef(5, "anlage-1/2.1")).toBe("5:anlage-1/2.1");
    expect(buildClauseRef(1, "praeambel")).toBe("1:praeambel");
  });

  it("rejects invalid pages and paths", () => {
    expect(() => buildClauseRef(0, "§1")).toThrow();
    expect(() => buildClauseRef(1.5, "§1")).toThrow();
    expect(() => buildClauseRef(1, "has space")).toThrow();
    expect(() => buildClauseRef(1, "has:colon")).toThrow();
    expect(() => buildClauseRef(1, "")).toThrow();
  });

  it("round-trips serialize -> parse", () => {
    const ref = buildClauseRef(12, "anlage-2/3.4.1");
    const serialized = serializeClauseId(DOC_ID, ref);
    expect(serialized).toBe(`${DOC_ID}:12:anlage-2/3.4.1`);

    const parsed = parseClauseId(serialized);
    expect(parsed).toEqual({
      documentId: DOC_ID,
      page: 12,
      clausePath: "anlage-2/3.4.1",
      clauseRef: "12:anlage-2/3.4.1",
    });
  });

  it("rejects malformed serialized ids", () => {
    expect(() => parseClauseId("not-a-uuid:1:§1")).toThrow();
    expect(() => parseClauseId(`${DOC_ID}:0:§1`)).toThrow();
    expect(() => parseClauseId(`${DOC_ID}:abc:§1`)).toThrow();
    expect(() => parseClauseId(DOC_ID)).toThrow();
  });

  it("clauseIdSchema accepts serialized ids and rejects refs/garbage", () => {
    expect(clauseIdSchema.safeParse(`${DOC_ID}:2:§11`).success).toBe(true);
    expect(clauseIdSchema.safeParse(`${DOC_ID}:3:anlage-1/2.1`).success).toBe(true);
    expect(clauseIdSchema.safeParse("2:§11").success).toBe(false);
    expect(clauseIdSchema.safeParse(`${DOC_ID}:0:§1`).success).toBe(false);
    expect(clauseIdSchema.safeParse("nope").success).toBe(false);
  });
});
