import { EXTRACTION_SCHEMAS, type ExtractionFamily } from "@contractix/shared/schemas";

/**
 * The order a family's fields should be read in.
 *
 * The API assembles report fields from an unordered `SELECT`, so without this
 * the terms table would be in whatever order Postgres returned - which is not a
 * reading order and is not even stable between requests. The Zod schemas
 * declare their fields in the order a human would ask about them (pay, then
 * equity, then leaver terms, then the rest), so their key order *is* the
 * intended order, and reusing it means the table cannot drift from the schema.
 */
export function fieldOrderFor(schemaVer: string): string[] {
  const family = schemaVer.split("@")[0];
  if (family === undefined || !(family in EXTRACTION_SCHEMAS)) return [];
  return Object.keys(EXTRACTION_SCHEMAS[family as ExtractionFamily].schema.shape);
}

/** Sorts fields into schema order; anything unrecognised keeps its place at the end. */
export function inSchemaOrder<T extends { fieldPath: string }>(
  fields: readonly T[],
  schemaVer: string,
): T[] {
  const order = fieldOrderFor(schemaVer);
  if (order.length === 0) return [...fields];

  const rank = new Map(order.map((key, i) => [key, i]));
  return [...fields].sort(
    (a, b) =>
      (rank.get(a.fieldPath) ?? Number.MAX_SAFE_INTEGER) -
      (rank.get(b.fieldPath) ?? Number.MAX_SAFE_INTEGER),
  );
}
