import {
  employmentExtractionSchema,
  termSheetExtractionSchema,
  vsopExtractionSchema,
} from "@contractix/shared";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { FakeLlm } from "./fake.js";
import { type JsonSchema } from "./types.js";

const FAMILIES = [
  ["employment", employmentExtractionSchema],
  ["vsop", vsopExtractionSchema],
  ["term_sheet", termSheetExtractionSchema],
] as const;

/**
 * The contract the extraction service (Workstream D) depends on: each family
 * schema converts to a ref-free JSON Schema (portable as an Anthropic tool
 * input_schema), and FakeLlm's schema walker returns a document that validates
 * against the source Zod schema — so the keyless path exercises validation +
 * persistence exactly like the real one.
 */
describe("extraction JSON-schema contract", () => {
  it("inlines refs and FakeLlm returns a schema-valid document for every family", async () => {
    for (const [name, schema] of FAMILIES) {
      const js = z.toJSONSchema(schema, { reused: "inline" }) as JsonSchema;
      expect(JSON.stringify(js), `${name}: refs should be inlined`).not.toContain("$ref");

      const { json } = await new FakeLlm().extract({
        system: "s",
        user: "u",
        toolName: "record_extraction",
        jsonSchema: js,
      });
      const parsed = schema.safeParse(json);
      expect(
        parsed.success,
        parsed.success ? name : JSON.stringify(parsed.error.issues.slice(0, 5)),
      ).toBe(true);
    }
  });
});
