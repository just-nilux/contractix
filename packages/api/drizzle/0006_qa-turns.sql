CREATE TABLE "qa_turns" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"question" text NOT NULL,
	"answer" text NOT NULL,
	"trace_json" jsonb NOT NULL,
	"grounded" boolean NOT NULL,
	"corrected" boolean NOT NULL,
	"could_not_verify" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"cost_eur" numeric(12, 6) NOT NULL,
	"latency_ms" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "citations" ADD COLUMN "answer_id" uuid;--> statement-breakpoint
ALTER TABLE "qa_turns" ADD CONSTRAINT "qa_turns_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "qa_turns_case_idx" ON "qa_turns" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "qa_turns_tenant_idx" ON "qa_turns" USING btree ("tenant_id");--> statement-breakpoint
ALTER TABLE "citations" ADD CONSTRAINT "citations_answer_id_qa_turns_id_fk" FOREIGN KEY ("answer_id") REFERENCES "public"."qa_turns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "citations_answer_idx" ON "citations" USING btree ("answer_id");