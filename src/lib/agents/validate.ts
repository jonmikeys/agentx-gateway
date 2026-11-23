import {
  ANIMATION_TOOL_NAMES,
  CAMERA_TOOL_NAMES,
  type ClientToolRestrictions,
  clientActionProblem,
  MEDIA_TOOL_NAMES,
} from "@/lib/agents/client-tools";
import {
  type FlowGraph,
  type FlowNode,
  flowNodeSchema,
  type NodeType,
  nodeHandles,
} from "@/lib/agents/graph";

/** One publish-blocking problem, optionally tied to a node so the editor can badge it. */
export interface ValidationProblem {
  nodeId?: string;
  nodeTitle?: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  problems: ValidationProblem[];
}

/** Resolved agent allow-lists used to validate Client Action references. */
export type ValidationRestrictions = ClientToolRestrictions;

const TERMINAL_TYPES: readonly NodeType[] = ["reply", "end"];

function titleOf(node: FlowNode | undefined, fallback: string): string {
  return node?.data.title ?? fallback;
}

function schemaProblems(graph: FlowGraph): ValidationProblem[] {
  const problems: ValidationProblem[] = [];
  for (const node of graph.nodes) {
    const result = flowNodeSchema.safeParse(node);
    if (result.success) continue;
    for (const issue of result.error.issues) {
      const path = issue.path.filter((part) => part !== "data").join(".");
      problems.push({
        nodeId: node.id,
        nodeTitle: titleOf(node as FlowNode, node.id),
        message: path ? `${path}: ${issue.message}` : issue.message,
      });
    }
  }
  return problems;
}

/** The source handle an edge connects to; a missing handle means the node's first output. */
function handleOf(edge: { sourceHandle?: string | null }, node: FlowNode): string {
  return (
    edge.sourceHandle ?? nodeHandles(node).find((handle) => handle.kind !== "error")?.id ?? "out"
  );
}

interface Adjacency {
  outgoing: Map<string, { handle: string; target: string; loop: boolean }[]>;
  incoming: Map<string, number>;
}

function buildAdjacency(graph: FlowGraph): Adjacency {
  const outgoing = new Map<string, { handle: string; target: string; loop: boolean }[]>();
  const incoming = new Map<string, number>();
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  for (const edge of graph.edges) {
    const source = byId.get(edge.source);
    if (!source) continue;
    const list = outgoing.get(edge.source) ?? [];
    list.push({
      handle: handleOf(edge, source),
      target: edge.target,
      loop: edge.data?.loop === true,
    });
    outgoing.set(edge.source, list);
    incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
  }
  return { outgoing, incoming };
}

function structuralProblems(graph: FlowGraph, adjacency: Adjacency): ValidationProblem[] {
  const problems: ValidationProblem[] = [];
  const byId = new Map<string, FlowNode>();
  for (const node of graph.nodes) {
    if (byId.has(node.id)) {
      problems.push({ nodeId: node.id, nodeTitle: node.data.title, message: "Duplicate node id" });
    }
    byId.set(node.id, node);
  }

  for (const edge of graph.edges) {
    if (!byId.has(edge.source)) {
      problems.push({ message: `Edge "${edge.id}" starts at an unknown node` });
    }
    if (!byId.has(edge.target)) {
      problems.push({ message: `Edge "${edge.id}" points at an unknown node` });
    }
  }

  const starts = graph.nodes.filter((node) => node.type === "start");
  if (starts.length !== 1) {
    problems.push({
      message:
        starts.length === 0
          ? "Add exactly one Start node"
          : "An agent must have exactly one Start node",
    });
  }
  const start = starts[0];

  if (start) {
    // Every non-error output must lead somewhere, and every node must be reachable.
    const reachable = new Set<string>();
    const queue: string[] = [start.id];
    while (queue.length > 0) {
      const id = queue.shift() as string;
      if (reachable.has(id)) continue;
      reachable.add(id);
      for (const edge of adjacency.outgoing.get(id) ?? []) {
        if (edge.target) queue.push(edge.target);
      }
    }

    for (const node of graph.nodes) {
      if (node === start) continue;
      if (!reachable.has(node.id)) {
        problems.push({
          nodeId: node.id,
          nodeTitle: node.data.title,
          message: "Node is not reachable from Start",
        });
      }
    }

    for (const node of graph.nodes) {
      if (!reachable.has(node.id)) continue;
      const handles = nodeHandles(node);
      for (const handle of handles) {
        if (handle.kind === "error") continue;
        const connected = (adjacency.outgoing.get(node.id) ?? []).some(
          (edge) => edge.handle === handle.id,
        );
        if (!connected) {
          problems.push({
            nodeId: node.id,
            nodeTitle: node.data.title,
            message:
              handles.filter((entry) => entry.kind !== "error").length === 1
                ? "Connect its output to another node"
                : `Connect the "${handle.label}" output`,
          });
        }
      }
    }
  }

  // Cycle rule: every back edge in a DFS must be marked as a loop.
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visited.has(id)) return;
    visiting.add(id);
    for (const edge of adjacency.outgoing.get(id) ?? []) {
      if (visiting.has(edge.target)) {
        if (!edge.loop) {
          const node = byId.get(id);
          problems.push({
            nodeId: id,
            nodeTitle: node?.data.title ?? id,
            message: "This edge closes a cycle; mark it as a loop edge to allow it",
          });
        }
        continue;
      }
      visit(edge.target);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const node of graph.nodes) visit(node.id);

  return problems;
}

function restrictionProblems(
  graph: FlowGraph,
  restrictions: ValidationRestrictions | undefined,
): ValidationProblem[] {
  const problems: ValidationProblem[] = [];
  for (const node of graph.nodes) {
    if (node.type !== "client_action") continue;
    const title = node.data.title;
    let args: Record<string, unknown>;
    try {
      const parsed = JSON.parse(node.data.argsTemplate.trim() || "{}") as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        problems.push({
          nodeId: node.id,
          nodeTitle: title,
          message: "Arguments must be a JSON object",
        });
        continue;
      }
      args = parsed as Record<string, unknown>;
    } catch {
      // Templates are interpolated at run time; only literal JSON can be checked here.
      continue;
    }
    const required = MEDIA_TOOL_NAMES.has(node.data.toolName)
      ? "media_id"
      : CAMERA_TOOL_NAMES.has(node.data.toolName)
        ? "camera_id"
        : ANIMATION_TOOL_NAMES.has(node.data.toolName)
          ? "animation_id"
          : undefined;
    if (required && (typeof args[required] !== "string" || args[required] === "")) {
      problems.push({
        nodeId: node.id,
        nodeTitle: title,
        message: `Choose a ${required.replace("_id", "")} for this Client Action`,
      });
      continue;
    }
    const problem = clientActionProblem(
      node.data.toolName,
      args,
      restrictions ?? {
        mediaIds: null,
        cameraIds: null,
      },
    );
    if (problem) problems.push({ nodeId: node.id, nodeTitle: title, message: problem });
  }
  return problems;
}

/**
 * Publish-time validation (spec §13): schema-valid nodes, exactly one Start, every path reaches a
 * Reply or End, no orphans, no cycles except edges marked `loop`. Returns per-node problems so the
 * CRM can badge the offending cards.
 */
export function validateGraph(
  graph: FlowGraph,
  restrictions?: ValidationRestrictions,
): ValidationResult {
  const problems = [
    ...schemaProblems(graph),
    ...structuralProblems(graph, buildAdjacency(graph)),
    ...restrictionProblems(graph, restrictions),
  ];
  return { valid: problems.length === 0, problems };
}

/** Convenience for the editor: problems grouped by node id. */
export function problemsByNode(result: ValidationResult): Map<string, ValidationProblem[]> {
  const map = new Map<string, ValidationProblem[]>();
  for (const problem of result.problems) {
    if (!problem.nodeId) continue;
    map.set(problem.nodeId, [...(map.get(problem.nodeId) ?? []), problem]);
  }
  return map;
}

/** Nodes whose output may be terminal (used by the compiler to decide streaming). */
export function isTerminalNodeType(type: NodeType): boolean {
  return TERMINAL_TYPES.includes(type);
}
