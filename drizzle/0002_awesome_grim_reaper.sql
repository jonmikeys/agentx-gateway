CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"api_key_id" uuid,
	"route_slug" text,
	"agent_id" text,
	"agent_version" integer,
	"status" text DEFAULT 'active' NOT NULL,
	"end_reason" text,
	"standalone" boolean DEFAULT false NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"turn_count" integer DEFAULT 0 NOT NULL,
	"system_prompt_hash" text
);
--> statement-breakpoint
CREATE TABLE "transcript_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"turn_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"kind" text NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"tool_call_id" text,
	"tool_name" text,
	"tool_args" jsonb,
	"tool_source" text,
	"llm_request_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"search" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', content)) STORED
);
--> statement-breakpoint
CREATE TABLE "turns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "llm_requests" ADD COLUMN "session_id" uuid;--> statement-breakpoint
ALTER TABLE "llm_requests" ADD COLUMN "turn_id" uuid;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcript_items" ADD CONSTRAINT "transcript_items_turn_id_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."turns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcript_items" ADD CONSTRAINT "transcript_items_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turns" ADD CONSTRAINT "turns_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sessions_status_activity_idx" ON "sessions" USING btree ("status","last_activity_at");--> statement-breakpoint
CREATE INDEX "sessions_started_at_idx" ON "sessions" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "sessions_api_key_idx" ON "sessions" USING btree ("api_key_id");--> statement-breakpoint
CREATE INDEX "transcript_items_session_seq_idx" ON "transcript_items" USING btree ("session_id","seq");--> statement-breakpoint
CREATE INDEX "transcript_items_turn_idx" ON "transcript_items" USING btree ("turn_id");--> statement-breakpoint
CREATE INDEX "transcript_items_search_idx" ON "transcript_items" USING gin ("search");--> statement-breakpoint
CREATE UNIQUE INDEX "turns_session_seq_idx" ON "turns" USING btree ("session_id","seq");--> statement-breakpoint
ALTER TABLE "llm_requests" ADD CONSTRAINT "llm_requests_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_requests" ADD CONSTRAINT "llm_requests_turn_id_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."turns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "llm_requests_session_idx" ON "llm_requests" USING btree ("session_id");