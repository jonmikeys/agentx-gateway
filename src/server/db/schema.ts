import { sql } from "drizzle-orm";
import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { FlowGraph, FlowKind } from "../../lib/agents/graph";
import type { FlowSettings, RunTrace } from "../../lib/agents/types";

/** Key/value settings (idle timeout, retention, ...). Populated by later stages. */
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Wire format of one LLM call: Chat Completions or the Responses API. */
export type LlmApi = "chat" | "responses";

export interface ProviderCapabilities {
  streaming: boolean;
  tools: boolean;
  responses_api: boolean;
}

/** Upstream OpenAI-compatible LLM endpoints. `api_key` and `extra_headers` are encrypted. */
export const providers = pgTable("providers", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  baseUrl: text("base_url").notNull(),
  /** Encrypted with encryptSecret(); null for keyless local servers (Ollama, ...). */
  apiKey: text("api_key"),
  enabled: boolean("enabled").notNull().default(true),
  capabilities: jsonb("capabilities")
    .$type<ProviderCapabilities>()
    .notNull()
    .default({ streaming: true, tools: true, responses_api: false }),
  /** Encrypted JSON string of `Record<string, string>`; null when none. */
  extraHeaders: text("extra_headers"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Client-visible model names (`model` = slug) that map to ordered provider steps. */
export const modelRoutes = pgTable(
  "model_routes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull().unique(),
    description: text("description").notNull().default(""),
    enabled: boolean("enabled").notNull().default(true),
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("model_routes_single_default_idx").on(table.isDefault).where(sql`is_default`),
  ],
);

export type McpTransport = "streamable_http" | "sse";

/**
 * External MCP servers (docs/mcp.md). `headers` is an encrypted JSON `Record<string,string>`
 * (for example Composio's `x-api-key` and `x-user-id`); `slug` prefixes every exposed tool name.
 */
export const mcpServers = pgTable("mcp_servers", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  slug: text("slug").notNull().unique(),
  url: text("url").notNull(),
  transport: text("transport").$type<McpTransport>().notNull().default("streamable_http"),
  /** Encrypted JSON string of `Record<string, string>`; null when none. */
  headers: text("headers"),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Tools reported by `tools/list`; only `allowed` ones are offered to models. */
export const mcpTools = pgTable(
  "mcp_tools",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    serverId: uuid("server_id")
      .notNull()
      .references(() => mcpServers.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    inputSchema: jsonb("input_schema").$type<unknown>().notNull().default({}),
    allowed: boolean("allowed").notNull().default(false),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  },
  (table) => [uniqueIndex("mcp_tools_server_name_idx").on(table.serverId, table.name)],
);

/** Route -> allowed MCP tool selection (a subset of `mcp_tools.allowed`). */
export const routeMcpTools = pgTable(
  "route_mcp_tools",
  {
    routeId: uuid("route_id")
      .notNull()
      .references(() => modelRoutes.id, { onDelete: "cascade" }),
    mcpToolId: uuid("mcp_tool_id")
      .notNull()
      .references(() => mcpTools.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.routeId, table.mcpToolId] })],
);

/**
 * Mixed client/MCP tool rounds. When one model reply asks for both Unity and MCP tools the
 * gateway answers the client with only the Unity calls, stores the MCP assistant/tool messages
 * here, and re-injects them when the client sends its tool results back.
 */
export const mcpPendingMessages = pgTable(
  "mcp_pending_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    /** Client-side tool call ids from the same assistant reply; the trigger for re-injection. */
    clientToolCallIds: text("client_tool_call_ids").array().notNull().default(sql`'{}'::text[]`),
    /** Chat-format assistant message with the MCP calls plus the matching tool result messages. */
    messages: jsonb("messages").$type<unknown[]>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("mcp_pending_messages_session_idx").on(table.sessionId)],
);

export const routeSteps = pgTable(
  "route_steps",
  {
    routeId: uuid("route_id")
      .notNull()
      .references(() => modelRoutes.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    providerId: uuid("provider_id")
      .notNull()
      .references(() => providers.id, { onDelete: "restrict" }),
    upstreamModel: text("upstream_model").notNull(),
    timeoutMs: integer("timeout_ms").notNull().default(30000),
  },
  (table) => [primaryKey({ columns: [table.routeId, table.position] })],
);

/** Gateway-issued client API keys. Only the SHA-256 hash is stored. */
export const apiKeys = pgTable("api_keys", {
  id: uuid("id").primaryKey().defaultRandom(),
  label: text("label").notNull(),
  keyPrefix: text("key_prefix").notNull(),
  keyHash: text("key_hash").notNull().unique(),
  ipAllowlist: text("ip_allowlist").array().notNull().default(sql`'{}'::text[]`),
  rpmLimit: integer("rpm_limit"),
  tokensPerDayLimit: integer("tokens_per_day_limit"),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Postgres-only rate counters (`minute` = requests, `day` = tokens). */
export const rateCounters = pgTable(
  "rate_counters",
  {
    apiKeyId: uuid("api_key_id")
      .notNull()
      .references(() => apiKeys.id, { onDelete: "cascade" }),
    windowKind: text("window_kind").$type<"minute" | "day">().notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    count: integer("count").notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.apiKeyId, table.windowKind, table.windowStart] })],
);

export interface RequestAttempt {
  provider_id: string;
  provider_name: string;
  model: string;
  outcome: string;
  http_status?: number;
  error_code?: string;
  latency_ms: number;
}

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

/** Postgres `tsvector`; only ever produced by a generated column, never written by the app. */
const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

export type SessionStatus = "active" | "expired" | "ended";
export type SessionEndReason = "idle" | "admin" | "agent_changed" | (string & {});

/**
 * One conversation, identified by the `X-Session-Id` the client echoes. `agent_id` and
 * `agent_version` are filled from G7a. `standalone` marks one-shot helper calls.
 */
export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    apiKeyId: uuid("api_key_id").references(() => apiKeys.id, { onDelete: "set null" }),
    routeSlug: text("route_slug"),
    agentId: text("agent_id"),
    agentVersion: integer("agent_version"),
    status: text("status").$type<SessionStatus>().notNull().default("active"),
    endReason: text("end_reason").$type<SessionEndReason>(),
    standalone: boolean("standalone").notNull().default(false),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    turnCount: integer("turn_count").notNull().default(0),
    systemPromptHash: text("system_prompt_hash"),
  },
  (table) => [
    index("sessions_status_activity_idx").on(table.status, table.lastActivityAt),
    index("sessions_started_at_idx").on(table.startedAt),
    index("sessions_api_key_idx").on(table.apiKeyId),
  ],
);

/** A user turn: starts at a user message and includes any client tool rounds that follow. */
export const turns = pgTable(
  "turns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [uniqueIndex("turns_session_seq_idx").on(table.sessionId, table.seq)],
);

export type TranscriptItemKind =
  | "system_prompt"
  | "user_message"
  | "assistant_message"
  | "reasoning"
  | "tool_call"
  | "tool_result"
  | "error";

/** Transcript content. Never logged. `search` is a generated tsvector for full-text search. */
export const transcriptItems = pgTable(
  "transcript_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    turnId: uuid("turn_id")
      .notNull()
      .references(() => turns.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    kind: text("kind").$type<TranscriptItemKind>().notNull(),
    content: text("content").notNull().default(""),
    toolCallId: text("tool_call_id"),
    toolName: text("tool_name"),
    toolArgs: jsonb("tool_args").$type<unknown>(),
    toolSource: text("tool_source").$type<"client" | "mcp">(),
    /** How long an MCP tool call took; null for client tools (the UI derives those from timestamps). */
    durationMs: integer("duration_ms"),
    llmRequestId: uuid("llm_request_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    search: tsvector("search").generatedAlwaysAs(sql`to_tsvector('english', content)`),
  },
  (table) => [
    index("transcript_items_session_seq_idx").on(table.sessionId, table.seq),
    index("transcript_items_turn_idx").on(table.turnId),
    index("transcript_items_search_idx").using("gin", table.search),
  ],
);

/**
 * One row per client LLM request. Never stores message content. `session_id` / `turn_id`
 * link it to the transcript (cascade on session delete).
 */
export const llmRequests = pgTable(
  "llm_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    apiKeyId: uuid("api_key_id").references(() => apiKeys.id, { onDelete: "set null" }),
    sessionId: uuid("session_id").references(() => sessions.id, { onDelete: "cascade" }),
    turnId: uuid("turn_id").references(() => turns.id, { onDelete: "cascade" }),
    routeSlug: text("route_slug"),
    providerId: uuid("provider_id").references(() => providers.id, { onDelete: "set null" }),
    upstreamModel: text("upstream_model"),
    stream: boolean("stream").notNull().default(false),
    /** API the client spoke (`chat` = /v1/chat/completions, `responses` = /v1/responses). */
    clientApi: text("client_api").$type<LlmApi>().notNull().default("chat"),
    /** API the answering provider was called with; null when no provider answered. */
    upstreamApi: text("upstream_api").$type<LlmApi>(),
    status: text("status").$type<"ok" | "error">().notNull(),
    httpStatus: integer("http_status"),
    errorCode: text("error_code"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    durationMs: integer("duration_ms"),
    ttftMs: integer("ttft_ms"),
    attempts: jsonb("attempts").$type<RequestAttempt[]>().notNull().default([]),
    usage: jsonb("usage").$type<TokenUsage>(),
  },
  (table) => [
    index("llm_requests_started_at_idx").on(table.startedAt),
    index("llm_requests_api_key_idx").on(table.apiKeyId),
    index("llm_requests_session_idx").on(table.sessionId),
  ],
);

export type MediaKind = "image" | "video";
export type MediaSource = "upload" | "external_url";

/**
 * Media the avatar may show (docs/media-content.md). `upload` items live in `MediaStorage`
 * under `storage_key`; `external_url` items are only linked (type and size checked on save).
 */
export const mediaItems = pgTable(
  "media_items",
  {
    /** `med_` + 12 hex characters. Stable: the model and Unity refer to it. */
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    kind: text("kind").$type<MediaKind>().notNull(),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    enabled: boolean("enabled").notNull().default(true),
    source: text("source").$type<MediaSource>().notNull(),
    /** Key inside `MediaStorage`; null for external items. */
    storageKey: text("storage_key"),
    /** Absolute http(s) URL; null for uploads. */
    externalUrl: text("external_url"),
    mimeType: text("mime_type").notNull(),
    /** Null when an external server did not report a size. */
    sizeBytes: integer("size_bytes"),
    width: integer("width"),
    height: integer("height"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("media_items_kind_idx").on(table.kind)],
);

/**
 * Camera feeds the avatar may show. `type` is an open union validated in application code
 * (`cameraInputSchema`): `lookat_sidecar` and `mjpeg_url` today, `rtsp_via_relay` reserved for
 * a future go2rtc/MediaMTX relay. `config` holds the type-specific fields (`{url}` for
 * `mjpeg_url`); `credentials` is an encrypted JSON `{username,password}` or null.
 */
export const cameras = pgTable("cameras", {
  /** `cam_` + 12 hex characters. */
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  enabled: boolean("enabled").notNull().default(true),
  type: text("type").notNull(),
  config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
  /** Encrypted with encryptSecret(); registered in encrypted-columns.ts. */
  credentials: text("credentials"),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Agents (published chatflows) and subflows. `draft` is the autosaved React Flow graph; published
 * versions are immutable rows in `flow_versions`. `slug` is fixed once a version exists.
 * `published_version` mirrors the highest published version for cheap listing.
 */
export const flows = pgTable(
  "flows",
  {
    /** `agt_` + 12 hex characters, stable across versions (Unity sends it as `agent_id`). */
    id: text("id").primaryKey(),
    kind: text("kind").$type<FlowKind>().notNull().default("agent"),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    description: text("description").notNull().default(""),
    enabled: boolean("enabled").notNull().default(true),
    settings: jsonb("settings")
      .$type<FlowSettings>()
      .notNull()
      .default({ default_route_slug: null, allowed_media_tags: [], allowed_cameras: [] }),
    draft: jsonb("draft").$type<FlowGraph>().notNull(),
    draftUpdatedAt: timestamp("draft_updated_at", { withTimezone: true }).notNull().defaultNow(),
    /** Highest published version; null until the first publish. */
    publishedVersion: integer("published_version"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("flows_enabled_idx").on(table.enabled)],
);

/** One immutable published graph per (flow, version). */
export const flowVersions = pgTable(
  "flow_versions",
  {
    flowId: text("flow_id")
      .notNull()
      .references(() => flows.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    graph: jsonb("graph").$type<FlowGraph>().notNull(),
    /**
     * Call Subflow pins: subflow id -> published version captured when this version was published
     * (spec §13). The parent always runs these versions, so republishing a subflow is opt-in.
     */
    pinnedSubflows: jsonb("pinned_subflows").$type<Record<string, number>>().notNull().default({}),
    note: text("note").notNull().default(""),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.flowId, table.version] })],
);

/**
 * Webhook header values live outside the graph so they are encrypted at rest and covered by key
 * rotation; the graph only stores header names. One row per (flow, node, header).
 */
export const flowWebhookSecrets = pgTable(
  "flow_webhook_secrets",
  {
    flowId: text("flow_id")
      .notNull()
      .references(() => flows.id, { onDelete: "cascade" }),
    nodeId: text("node_id").notNull(),
    name: text("name").notNull(),
    /** AES-256-GCM blob (encryptSecret); registered in encrypted-columns.ts. */
    value: text("value").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.flowId, table.nodeId, table.name] })],
);

/** Per-node trace of one agent run, linked from the transcript by session and turn. */
export const runLogs = pgTable(
  "run_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id").references(() => sessions.id, { onDelete: "cascade" }),
    turnId: uuid("turn_id").references(() => turns.id, { onDelete: "cascade" }),
    flowId: text("flow_id").references(() => flows.id, { onDelete: "set null" }),
    version: integer("version"),
    trace: jsonb("trace").$type<RunTrace>(),
    status: text("status").$type<"ok" | "error">().notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    durationMs: integer("duration_ms"),
  },
  (table) => [
    index("run_logs_session_idx").on(table.sessionId),
    index("run_logs_turn_idx").on(table.turnId),
  ],
);

/** Session-scoped memory written by Memory nodes and shown in the transcript viewer. */
export const sessionMemory = pgTable(
  "session_memory",
  {
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    value: jsonb("value").$type<unknown>(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.sessionId, table.key] })],
);
