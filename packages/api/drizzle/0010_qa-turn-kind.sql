ALTER TABLE "qa_turns" ADD COLUMN "kind" text DEFAULT 'ask' NOT NULL;--> statement-breakpoint
ALTER TABLE "qa_turns" ADD COLUMN "document_id" uuid;--> statement-breakpoint
ALTER TABLE "qa_turns" ADD COLUMN "prompt_version" text DEFAULT 'agent@2' NOT NULL;--> statement-breakpoint
ALTER TABLE "qa_turns" ADD CONSTRAINT "qa_turns_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "qa_turns_case_kind_idx" ON "qa_turns" USING btree ("case_id","kind","created_at" DESC NULLS LAST);