ALTER TABLE "tenants" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "origin" text DEFAULT 'upload' NOT NULL;--> statement-breakpoint
CREATE INDEX "tenants_expires_idx" ON "tenants" USING btree ("expires_at") WHERE "tenants"."expires_at" is not null;