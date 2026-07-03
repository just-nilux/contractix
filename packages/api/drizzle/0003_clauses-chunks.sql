CREATE TABLE "clauses" (
	"id" uuid PRIMARY KEY NOT NULL,
	"document_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"clause_ref" text NOT NULL,
	"clause_path" text NOT NULL,
	"heading" text,
	"heading_path" text[] NOT NULL,
	"page" integer NOT NULL,
	"char_start" integer NOT NULL,
	"char_end" integer NOT NULL,
	"text" text NOT NULL,
	"seq" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chunks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"clause_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"chunk_index" integer NOT NULL,
	"text" text NOT NULL,
	"char_start" integer NOT NULL,
	"char_end" integer NOT NULL,
	"token_count" integer NOT NULL,
	"language" text NOT NULL,
	"embedding" vector(1024),
	"embedding_model" text NOT NULL,
	"tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector(CASE WHEN "language" = 'de' THEN 'german'::regconfig ELSE 'english'::regconfig END, "text")) STORED
);
--> statement-breakpoint
ALTER TABLE "clauses" ADD CONSTRAINT "clauses_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_clause_id_clauses_id_fk" FOREIGN KEY ("clause_id") REFERENCES "public"."clauses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "clauses_doc_ref_uq" ON "clauses" USING btree ("document_id","clause_ref");--> statement-breakpoint
CREATE INDEX "clauses_doc_seq_idx" ON "clauses" USING btree ("document_id","seq");--> statement-breakpoint
CREATE INDEX "clauses_tenant_idx" ON "clauses" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chunks_clause_idx_uq" ON "chunks" USING btree ("clause_id","chunk_index");--> statement-breakpoint
CREATE INDEX "chunks_tenant_case_idx" ON "chunks" USING btree ("tenant_id","case_id");--> statement-breakpoint
CREATE INDEX "chunks_document_idx" ON "chunks" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "chunks_embedding_hnsw" ON "chunks" USING hnsw ("embedding" vector_cosine_ops) WITH (m=16,ef_construction=64);--> statement-breakpoint
CREATE INDEX "chunks_tsv_gin" ON "chunks" USING gin ("tsv");--> statement-breakpoint
CREATE INDEX "chunks_text_trgm" ON "chunks" USING gin ("text" gin_trgm_ops);