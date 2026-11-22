import { sql } from "drizzle-orm";
import {
  boolean,
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

/**
 * One row per client LLM request. Never stores message content. G3 adds nullable
 * `session_id` / `turn_id` columns.
 */
export const llmRequests = pgTable(
  "llm_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    apiKeyId: uuid("api_key_id").references(() => apiKeys.id, { onDelete: "set null" }),
    routeSlug: text("route_slug"),
    providerId: uuid("provider_id").references(() => providers.id, { onDelete: "set null" }),
    upstreamModel: text("upstream_model"),
    stream: boolean("stream").notNull().default(false),
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
  ],
);
