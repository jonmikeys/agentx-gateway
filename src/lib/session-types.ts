/** JSON shapes of the sessions admin API, shared by the services and the CRM (no server imports). */

export type SessionStatus = "active" | "expired" | "ended";

export type TranscriptItemKind =
  | "system_prompt"
  | "user_message"
  | "assistant_message"
  | "reasoning"
  | "tool_call"
  | "tool_result"
  | "error";

export interface SessionSummary {
  id: string;
  api_key_id: string | null;
  api_key_label: string | null;
  route_slug: string | null;
  agent_id: string | null;
  agent_version: number | null;
  status: SessionStatus;
  end_reason: string | null;
  standalone: boolean;
  started_at: string;
  last_activity_at: string;
  ended_at: string | null;
  turn_count: number;
}

export interface TranscriptItemView {
  id: string;
  turn_id: string;
  seq: number;
  kind: TranscriptItemKind;
  content: string;
  tool_call_id: string | null;
  tool_name: string | null;
  tool_args: unknown;
  tool_source: "client" | "mcp" | null;
  /** MCP call duration; null for client tools (derived from timestamps in the viewer). */
  duration_ms: number | null;
  llm_request_id: string | null;
  created_at: string;
}

export interface RequestAttemptView {
  provider_id: string;
  provider_name: string;
  model: string;
  outcome: string;
  http_status?: number;
  error_code?: string;
  latency_ms: number;
}

export interface LinkedRequestView {
  id: string;
  turn_id: string | null;
  route_slug: string | null;
  provider_id: string | null;
  provider_name: string | null;
  upstream_model: string | null;
  stream: boolean;
  /** API the client spoke and the API the provider was called with (differ when translated). */
  client_api: "chat" | "responses";
  upstream_api: "chat" | "responses" | null;
  status: "ok" | "error";
  http_status: number | null;
  error_code: string | null;
  started_at: string;
  duration_ms: number | null;
  ttft_ms: number | null;
  attempts: RequestAttemptView[];
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null;
}

export interface TurnView {
  id: string;
  seq: number;
  started_at: string;
  completed_at: string | null;
  items: TranscriptItemView[];
  requests: LinkedRequestView[];
}

export interface SessionDetail extends SessionSummary {
  system_prompt_hash: string | null;
  turns: TurnView[];
}

export interface SessionListResponse {
  data: SessionSummary[];
  total: number;
  page: number;
  page_size: number;
}

export interface SessionSettings {
  idle_timeout_minutes: number;
  retention_days: number;
  redaction_enabled: boolean;
}

export const DEFAULT_SESSION_SETTINGS: SessionSettings = {
  idle_timeout_minutes: 30,
  retention_days: 90,
  redaction_enabled: false,
};

export interface DashboardStats {
  active_sessions: number;
  sessions_today: number;
  turns_today: number;
  tokens_today: number;
  per_day: {
    day: string;
    sessions: number;
    turns: number;
    failovers: number;
    errors: number;
  }[];
  tokens_per_provider: { provider: string; tokens: number }[];
  slowest_providers: {
    provider: string;
    requests: number;
    avg_ttft_ms: number | null;
    avg_latency_ms: number | null;
  }[];
}
