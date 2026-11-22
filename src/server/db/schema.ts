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
