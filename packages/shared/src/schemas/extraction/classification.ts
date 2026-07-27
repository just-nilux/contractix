import { z } from "zod";

import { documentTypeSchema } from "../documents.js";
import { confidenceSchema } from "./field.js";

/**
 * FR-1.2 document classification. The classifier (classifier-service.ts) drives a
 * single forced `classify_document` tool over this schema, choosing exactly one of
 * the seven taxonomy types (documents.ts). A lone enum needs no repair pass —
 * invalid output degrades to `other`/`low` at the service. `reasoning` is optional
 * free text the model may return for traceability; it is not persisted. Confidence
 * reuses the extraction band (field.ts) so one vocabulary spans the pipeline.
 */
export const classificationSchema = z.object({
  document_type: documentTypeSchema,
  confidence: confidenceSchema,
  reasoning: z.string().optional(),
});
export type Classification = z.infer<typeof classificationSchema>;
