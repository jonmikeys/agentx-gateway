import { type FlowGraph, flowGraphSchema, flowKindSchema } from "@/lib/agents/graph";
import type { FlowSettings } from "@/lib/agents/types";
import { type ValidationProblem, validateGraph } from "@/lib/agents/validate";

/**
 * Human-readable JSON import/export (spec §14). Secrets are never exported: webhook headers keep
 * their names only, and importing lists the headers the user must re-link in the properties panel.
 */
export const EXPORT_FORMAT = "agentx.chatflow";
export const EXPORT_FORMAT_VERSION = 1;

export interface ExportMeta {
  name: string;
  slug: string;
  kind: "agent" | "subflow";
  description: string;
  settings: FlowSettings;
  version: number | null;
}

export interface FlowExport {
  format: typeof EXPORT_FORMAT;
  format_version: number;
  exported_at: string;
  flow: ExportMeta;
  graph: FlowGraph;
}

export interface ImportedFlow {
  name: string;
  slug?: string;
  kind: "agent" | "subflow";
  description: string;
  settings: FlowSettings;
  graph: FlowGraph;
  missingSecrets: string[];
}

export type ImportResult =
  | { ok: true; flow: ImportedFlow }
  | { ok: false; errors: string[]; problems: ValidationProblem[] };

const EMPTY_SETTINGS: FlowSettings = {
  default_route_slug: null,
  allowed_media_tags: [],
  allowed_cameras: [],
};

/** Drops write-only secret values and masks before a graph leaves the app. */
export function stripGraphForExport(graph: FlowGraph): FlowGraph {
  const copy = structuredClone(graph);
  for (const node of copy.nodes) {
    if (node.type !== "webhook") continue;
    node.data.headers = node.data.headers.map((header) => ({ name: header.name }));
  }
  return copy;
}

export function buildExportPayload(meta: ExportMeta, graph: FlowGraph): FlowExport {
  return {
    format: EXPORT_FORMAT,
    format_version: EXPORT_FORMAT_VERSION,
    exported_at: new Date().toISOString(),
    flow: meta,
    graph: stripGraphForExport(graph),
  };
}

/** Webhook headers an imported flow must re-link (every imported header has no stored value). */
export function missingSecretHeaders(graph: FlowGraph): string[] {
  const missing: string[] = [];
  for (const node of graph.nodes) {
    if (node.type !== "webhook") continue;
    for (const header of node.data.headers) {
      if (header.value) continue;
      missing.push(`${node.data.title}: ${header.name}`);
    }
  }
  return missing;
}

/** Unique-ish slug for a newly imported flow; imports never reuse an exported slug. */
function importSlug(name: string): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "chatflow";
  const suffix = Math.random().toString(36).slice(2, 6);
  return `${base}-${suffix}`.slice(0, 64);
}

function readSettings(raw: unknown): FlowSettings {
  if (!raw || typeof raw !== "object") return { ...EMPTY_SETTINGS };
  const value = raw as Record<string, unknown>;
  const strings = (input: unknown): string[] =>
    Array.isArray(input) ? input.filter((entry): entry is string => typeof entry === "string") : [];
  return {
    default_route_slug:
      typeof value.default_route_slug === "string" ? value.default_route_slug : null,
    allowed_media_tags: strings(value.allowed_media_tags),
    allowed_cameras: strings(value.allowed_cameras),
  };
}

/**
 * Parses an exported payload (or a bare React Flow graph), checks the schema and runs the same
 * publish-time validation the editor uses. Invalid flows are rejected with per-node problems.
 */
export function parseImportedFlow(raw: string): ImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      ok: false,
      errors: [`Not valid JSON: ${error instanceof Error ? error.message : "parse failed"}`],
      problems: [],
    };
  }
  if (!parsed || typeof parsed !== "object") {
    return { ok: false, errors: ["The file does not contain a chatflow object"], problems: [] };
  }

  const container = parsed as Record<string, unknown>;
  const graphCandidate =
    container.graph && typeof container.graph === "object" ? container.graph : container;
  const meta =
    container.flow && typeof container.flow === "object"
      ? (container.flow as Record<string, unknown>)
      : {};

  const graph = flowGraphSchema.safeParse(graphCandidate);
  if (!graph.success) {
    return {
      ok: false,
      errors: graph.error.issues
        .slice(0, 10)
        .map((issue) => `${issue.path.join(".") || "graph"}: ${issue.message}`),
      problems: [],
    };
  }

  const validation = validateGraph(graph.data);
  if (!validation.valid) {
    return {
      ok: false,
      errors: ["The imported flow has validation problems"],
      problems: validation.problems,
    };
  }

  const kind = flowKindSchema.safeParse(meta.kind);
  const name =
    typeof meta.name === "string" && meta.name.trim()
      ? meta.name.trim().slice(0, 120)
      : "Imported chatflow";
  return {
    ok: true,
    flow: {
      name,
      slug: importSlug(name),
      kind: kind.success ? kind.data : "agent",
      description:
        typeof meta.description === "string" ? meta.description.trim().slice(0, 1000) : "",
      settings: readSettings(meta.settings),
      graph: graph.data,
      missingSecrets: missingSecretHeaders(graph.data),
    },
  };
}

/** Browser download helper; never called in tests. */
export function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
