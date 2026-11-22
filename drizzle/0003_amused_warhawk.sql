ALTER TABLE "llm_requests" ADD COLUMN "client_api" text DEFAULT 'chat' NOT NULL;--> statement-breakpoint
ALTER TABLE "llm_requests" ADD COLUMN "upstream_api" text;--> statement-breakpoint
UPDATE "llm_requests" SET "upstream_api" = 'chat' WHERE "provider_id" IS NOT NULL OR "upstream_model" IS NOT NULL;
