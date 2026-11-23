CREATE TABLE "mcp_pending_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"client_tool_call_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"messages" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_servers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"url" text NOT NULL,
	"transport" text DEFAULT 'streamable_http' NOT NULL,
	"headers" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_servers_name_unique" UNIQUE("name"),
	CONSTRAINT "mcp_servers_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "mcp_tools" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"input_schema" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"allowed" boolean DEFAULT false NOT NULL,
	"last_seen_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "route_mcp_tools" (
	"route_id" uuid NOT NULL,
	"mcp_tool_id" uuid NOT NULL,
	CONSTRAINT "route_mcp_tools_route_id_mcp_tool_id_pk" PRIMARY KEY("route_id","mcp_tool_id")
);
--> statement-breakpoint
ALTER TABLE "transcript_items" ADD COLUMN "duration_ms" integer;--> statement-breakpoint
ALTER TABLE "mcp_pending_messages" ADD CONSTRAINT "mcp_pending_messages_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_tools" ADD CONSTRAINT "mcp_tools_server_id_mcp_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."mcp_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "route_mcp_tools" ADD CONSTRAINT "route_mcp_tools_route_id_model_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."model_routes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "route_mcp_tools" ADD CONSTRAINT "route_mcp_tools_mcp_tool_id_mcp_tools_id_fk" FOREIGN KEY ("mcp_tool_id") REFERENCES "public"."mcp_tools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mcp_pending_messages_session_idx" ON "mcp_pending_messages" USING btree ("session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_tools_server_name_idx" ON "mcp_tools" USING btree ("server_id","name");