import { type DocumentType, type ExtractedFields } from "@contractix/shared";

export type Severity = "red" | "amber" | "info";

/** Rule copy + applicability, authored in rules.yaml (versioned, non-code). */
export interface RuleMeta {
  id: string;
  appliesTo: DocumentType[];
  severity: Severity;
  rationale: string;
  negotiationHint?: string;
  sources: string[];
}

export interface RuleContext {
  documentType: DocumentType;
}

/**
 * A deterministic check over an extraction. Returns the field paths that
 * triggered the rule (so the benchmark can cite their clauses), or null when
 * the rule does not fire.
 */
export type CheckFn = (ex: ExtractedFields, ctx: RuleContext) => string[] | null;

export interface Rule extends RuleMeta {
  check: CheckFn;
}

/** A triggered rule. clause citations are resolved from triggeringFields downstream. */
export interface Flag {
  ruleId: string;
  ruleVersion: string;
  severity: Severity;
  rationale: string;
  negotiationHint?: string;
  sources: string[];
  triggeringFields: string[];
}
