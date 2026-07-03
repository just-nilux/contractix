import { describe, expect, it } from "vitest";

import { blockSchema, canonicalText } from "./blocks.js";

describe("block schema", () => {
  it("accepts a well-formed PDF block", () => {
    const block = {
      page: 1,
      bbox: { x: 56.7, y: 120.2, width: 480.1, height: 14.5 },
      type: "heading",
      text: "§ 1 Beginn des Arbeitsverhältnisses",
      charStart: 0,
      charEnd: 35,
    };
    expect(blockSchema.parse(block)).toEqual(block);
  });

  it("accepts null bbox (DOCX has no geometry)", () => {
    const block = {
      page: 1,
      bbox: null,
      type: "paragraph",
      text: "Ziffer 1 Vertragsgegenstand",
      charStart: 0,
      charEnd: 27,
    };
    expect(blockSchema.parse(block).bbox).toBeNull();
  });

  it("rejects unknown block types and negative offsets", () => {
    expect(() =>
      blockSchema.parse({
        page: 1,
        bbox: null,
        type: "sidebar",
        text: "x",
        charStart: 0,
        charEnd: 1,
      }),
    ).toThrow();
    expect(() =>
      blockSchema.parse({
        page: 1,
        bbox: null,
        type: "paragraph",
        text: "x",
        charStart: -1,
        charEnd: 1,
      }),
    ).toThrow();
  });
});

describe("canonicalText", () => {
  it("joins block texts with newline - the offset reference frame", () => {
    const text = canonicalText([{ text: "A" }, { text: "BB" }, { text: "C" }]);
    expect(text).toBe("A\nBB\nC");
    // Frozen-offset convention: block N+1 starts at end of block N + 1 (the \n).
    expect(text.slice(2, 4)).toBe("BB");
  });
});
