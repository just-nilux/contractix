CREATE TYPE "public"."document_status" AS ENUM('uploaded', 'processing', 'ready', 'failed');--> statement-breakpoint
CREATE TYPE "public"."document_type" AS ENUM('employment_offer', 'employment_contract', 'vsop_esop_agreement', 'term_sheet', 'shareholders_agreement', 'side_letter', 'other');--> statement-breakpoint
CREATE TYPE "public"."language" AS ENUM('de', 'en', 'mixed');--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"case_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"sha256" text NOT NULL,
	"filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"page_count" integer,
	"language" "language",
	"type" "document_type",
	"status" "document_status" DEFAULT 'uploaded' NOT NULL,
	"parse_report" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "documents_case_sha_uq" ON "documents" USING btree ("case_id","sha256");--> statement-breakpoint
CREATE INDEX "documents_tenant_idx" ON "documents" USING btree ("tenant_id");