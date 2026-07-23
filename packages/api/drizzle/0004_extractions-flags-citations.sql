CREATE TYPE "public"."extraction_confidence" AS ENUM('high', 'medium', 'low');--> statement-breakpoint
CREATE TYPE "public"."extraction_status" AS ENUM('extracted', 'not_found', 'extraction_failed');--> statement-breakpoint
CREATE TYPE "public"."citation_source" AS ENUM('extraction', 'answer');--> statement-breakpoint
CREATE TYPE "public"."flag_severity" AS ENUM('red', 'amber', 'info');--> statement-breakpoint
CREATE TABLE "extractions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"document_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"schema_ver" text NOT NULL,
	"field_path" text NOT NULL,
	"value" jsonb,
	"unit" text,
	"confidence" "extraction_confidence" NOT NULL,
	"status" "extraction_status" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "citations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"source_type" "citation_source" NOT NULL,
	"extraction_id" uuid,
	"clause_id" uuid NOT NULL,
	"char_start" integer NOT NULL,
	"char_end" integer NOT NULL,
	"verbatim_anchor" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "flags" (
	"id" uuid PRIMARY KEY NOT NULL,
	"document_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"rule_id" text NOT NULL,
	"rule_version" text NOT NULL,
	"severity" "flag_severity" NOT NULL,
	"clause_ids" uuid[] NOT NULL,
	"rationale" text NOT NULL,
	"negotiation_hint" text,
	"sources" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "extractions" ADD CONSTRAINT "extractions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "citations" ADD CONSTRAINT "citations_extraction_id_extractions_id_fk" FOREIGN KEY ("extraction_id") REFERENCES "public"."extractions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "citations" ADD CONSTRAINT "citations_clause_id_clauses_id_fk" FOREIGN KEY ("clause_id") REFERENCES "public"."clauses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flags" ADD CONSTRAINT "flags_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "extractions_doc_field_uq" ON "extractions" USING btree ("document_id","schema_ver","field_path");--> statement-breakpoint
CREATE INDEX "extractions_tenant_idx" ON "extractions" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "extractions_document_idx" ON "extractions" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "citations_extraction_idx" ON "citations" USING btree ("extraction_id");--> statement-breakpoint
CREATE INDEX "citations_clause_idx" ON "citations" USING btree ("clause_id");--> statement-breakpoint
CREATE INDEX "citations_tenant_idx" ON "citations" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "flags_doc_rule_uq" ON "flags" USING btree ("document_id","rule_id");--> statement-breakpoint
CREATE INDEX "flags_tenant_idx" ON "flags" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "flags_document_idx" ON "flags" USING btree ("document_id");