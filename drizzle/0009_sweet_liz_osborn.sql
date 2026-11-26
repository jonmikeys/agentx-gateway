CREATE TABLE "web_media_items" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"api_key_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"source_page_url" text,
	"media_url" text NOT NULL,
	"thumbnail_url" text,
	"resolution" text,
	"duration_seconds" integer,
	"resolved_url" text,
	"resolved_mime_type" text,
	"resolved_headers" jsonb,
	"resolved_at" timestamp with time zone,
	"resolve_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "web_media_items" ADD CONSTRAINT "web_media_items_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_media_items" ADD CONSTRAINT "web_media_items_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "web_media_items_session_idx" ON "web_media_items" USING btree ("session_id");