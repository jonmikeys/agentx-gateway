CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"label" text NOT NULL,
	"key_prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"ip_allowlist" text[] DEFAULT '{}'::text[] NOT NULL,
	"rpm_limit" integer,
	"tokens_per_day_limit" integer,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "llm_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"api_key_id" uuid,
	"route_slug" text,
	"provider_id" uuid,
	"upstream_model" text,
	"stream" boolean DEFAULT false NOT NULL,
	"status" text NOT NULL,
	"http_status" integer,
	"error_code" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"duration_ms" integer,
	"ttft_ms" integer,
	"attempts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"usage" jsonb
);
--> statement-breakpoint
CREATE TABLE "model_routes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_routes_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"base_url" text NOT NULL,
	"api_key" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"capabilities" jsonb DEFAULT '{"streaming":true,"tools":true,"responses_api":false}'::jsonb NOT NULL,
	"extra_headers" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "providers_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "rate_counters" (
	"api_key_id" uuid NOT NULL,
	"window_kind" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "rate_counters_api_key_id_window_kind_window_start_pk" PRIMARY KEY("api_key_id","window_kind","window_start")
);
--> statement-breakpoint
CREATE TABLE "route_steps" (
	"route_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"provider_id" uuid NOT NULL,
	"upstream_model" text NOT NULL,
	"timeout_ms" integer DEFAULT 30000 NOT NULL,
	CONSTRAINT "route_steps_route_id_position_pk" PRIMARY KEY("route_id","position")
);
--> statement-breakpoint
ALTER TABLE "llm_requests" ADD CONSTRAINT "llm_requests_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_requests" ADD CONSTRAINT "llm_requests_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_counters" ADD CONSTRAINT "rate_counters_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "route_steps" ADD CONSTRAINT "route_steps_route_id_model_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."model_routes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "route_steps" ADD CONSTRAINT "route_steps_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "llm_requests_started_at_idx" ON "llm_requests" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "llm_requests_api_key_idx" ON "llm_requests" USING btree ("api_key_id");--> statement-breakpoint
CREATE UNIQUE INDEX "model_routes_single_default_idx" ON "model_routes" USING btree ("is_default") WHERE is_default;