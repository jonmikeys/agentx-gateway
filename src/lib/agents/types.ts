import type { FlowGraph, FlowKind } from "@/lib/agents/graph";

/** Agent settings stored in `flows.settings` (spec §14, Agent settings tab). */
export interface FlowSettings {
  default_route_slug: string | null;
  /** G7b restrictions; stored now so graphs and settings stay forward-compatible. */
  allowed_media_tags: string[];
  allowed_cameras: string[];
}

export const DEFAULT_FLOW_SETTINGS: FlowSettings = {
  default_route_slug: null,
  allowed_media_tags: [],
  allowed_cameras: [],
};

export interface FlowSummary {
  id: string;
  kind: FlowKind;
  name: string;
  slug: string;
  description: string;
  enabled: boolean;
  settings: FlowSettings;
  published_version: number | null;
  draft_updated_at: string;
  created_at: string;
  updated_at: string;
  node_count: number;
}

export interface FlowDetail extends FlowSummary {
  draft: FlowGraph;
  version_count: number;
}

export interface FlowVersionSummary {
  flow_id: string;
  version: number;
  note: string;
  published_at: string;
  node_count: number;
}

export interface FlowVersionDetail extends FlowVersionSummary {
  graph: FlowGraph;
}

export type RunStepStatus = "ok" | "error" | "skipped";

export interface RunTraceStep {
  node_id: string;
  node_type: string;
  title: string;
  status: RunStepStatus;
  started_at: string;
  duration_ms: number;
  input?: unknown;
  output?: unknown;
  error?: string;
}

export interface RunTrace {
  run_id: string;
  flow_id: string;
  version: number;
  status: "ok" | "error";
  started_at: string;
  duration_ms: number;
  steps: RunTraceStep[];
  error?: string;
  /** Node whose execution was in flight when the run failed. */
  failed_node_id?: string | null;
  /** True when the run stopped at a client-tool interrupt and waits for the client. */
  paused?: boolean;
}

/** One `session_memory` row as shown by the transcript viewer. */
export interface SessionMemoryView {
  key: string;
  value: unknown;
  updated_at: string;
}

export interface RunLogView {
  id: string;
  session_id: string | null;
  turn_id: string | null;
  flow_id: string | null;
  version: number | null;
  flow_name: string | null;
  status: "ok" | "error";
  started_at: string;
  duration_ms: number | null;
  trace: RunTrace | null;
}

export interface AgentListEntry {
  id: string;
  object: "agent";
  name: string;
  description: string;
  created: number;
}

/** Events emitted by a streamed admin test run (`POST /api/admin/flows/:id/test-run`). */
export type AgentTestEvent =
  | { type: "node_start"; node_id: string; node_type: string; title: string }
  | {
      type: "node_end";
      node_id: string;
      status: RunStepStatus;
      duration_ms: number;
      error?: string;
    }
  | { type: "text"; delta: string }
  | { type: "done"; reply: string; trace: RunTrace }
  | { type: "error"; message: string; trace?: RunTrace };

/** Events the runtime emits to the client API adapter (production runs). */
export interface AgentRuntimeEvent {
  type: "node_start" | "node_end" | "text" | "done";
  nodeId?: string;
  nodeType?: string;
  title?: string;
  status?: RunStepStatus;
  durationMs?: number;
  error?: string;
  delta?: string;
  reply?: string;
  trace?: RunTrace;
}
