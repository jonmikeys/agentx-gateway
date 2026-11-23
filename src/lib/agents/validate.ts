import {
  ANIMATION_TOOL_NAMES,
  CAMERA_TOOL_NAMES,
  type ClientToolRestrictions,
  clientActionProblem,
  MEDIA_TOOL_NAMES,
} from "@/lib/agents/client-tools";
import {
  type FlowGraph,
  type FlowKind,
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

export interface ValidationOptions {
  /** Defaults to `agent` so existing callers keep their behaviour. */
  kind?: FlowKind;
  /** The resolved allow-lists of the calling agent, when validating at publish time. */
  restrictions?: ValidationRestrictions;
}

const AGENT_TERMINAL_TYPES: readonly NodeType[] = ["reply", "end"];
const SUBFLOW_TERMINAL_TYPES: readonly NodeType[] = ["subflow_output"];

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

/** Subflow-only structural rules: one input, at least one uniquely labelled output. */
function subflowProblems(graph: FlowGraph): ValidationProblem[] {
  const problems: ValidationProblem[] = [];
  for (const node of graph.nodes) {
    if (node.type === "start" || node.type === "end") {
      problems.push({
        nodeId: node.id,
        nodeTitle: node.data.title,
        message: "Subflows use Subflow Input and Subflow Output instead of Start and End",
      });
    }
  }
  const inputs = graph.nodes.filter((node) => node.type === "subflow_input");
  if (inputs.length !== 1) {
    problems.push({
      message:
        inputs.length === 0
          ? "Add exactly one Subflow Input node"
          : "A subflow must have exactly one Subflow Input node",
    });
  }
  const outputs = graph.nodes.filter((node) => node.type === "subflow_output");
  if (outputs.length === 0) {
    problems.push({ message: "Add at least one Subflow Output node" });
  }
  const labels = outputs.map((node) => (node.type === "subflow_output" ? node.data.label : ""));
  if (new Set(labels).size !== labels.length) {
    problems.push({ message: "Subflow Output labels must be unique" });
  }
  return problems;
}

function callSubflowProblems(graph: FlowGraph): ValidationProblem[] {
  const problems: ValidationProblem[] = [];
  for (const node of graph.nodes) {
    if (node.type !== "call_subflow") continue;
    if (node.data.outputs.length === 0) {
      problems.push({
        nodeId: node.id,
        nodeTitle: node.data.title,
        message: "Add at least one output label",
      });
    }
    const labels = node.data.outputs.map((output) => output.label);
    if (new Set(labels).size !== labels.length) {
      problems.push({
        nodeId: node.id,
        nodeTitle: node.data.title,
        message: "Output labels must be unique",
      });
    }
  }
  return problems;
}

function structuralProblems(
  graph: FlowGraph,
  adjacency: Adjacency,
  kind: FlowKind,
): ValidationProblem[] {
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

  if (kind === "subflow") problems.push(...subflowProblems(graph));
  problems.push(...callSubflowProblems(graph));

  const starts = graph.nodes.filter((node) => node.type === "start");
  const inputs = graph.nodes.filter((node) => node.type === "subflow_input");
  if (kind === "subflow") {
    if (starts.length > 0) {
      // Already reported by subflowProblems; avoid a duplicate "one Start" message.
    }
  } else if (starts.length !== 1) {
    problems.push({
      message:
        starts.length === 0
          ? "Add exactly one Start node"
          : "An agent must have exactly one Start node",
    });
  }
  const root = kind === "subflow" ? inputs[0] : starts[0];

  if (root) {
    // Every non-error output must lead somewhere, and every node must be reachable.
    const reachable = new Set<string>();
    const queue: string[] = [root.id];
    while (queue.length > 0) {
      const id = queue.shift() as string;
      if (reachable.has(id)) continue;
      reachable.add(id);
      for (const edge of adjacency.outgoing.get(id) ?? []) {
        if (edge.target) queue.push(edge.target);
      }
    }

    for (const node of graph.nodes) {
      if (node === root) continue;
      if (!reachable.has(node.id)) {
        problems.push({
          nodeId: node.id,
          nodeTitle: node.data.title,
          message:
            kind === "subflow"
              ? "Node is not reachable from Subflow Input"
              : "Node is not reachable from Start",
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

    const terminalTypes = kind === "subflow" ? SUBFLOW_TERMINAL_TYPES : AGENT_TERMINAL_TYPES;
    const terminals = graph.nodes.filter(
      (node) => reachable.has(node.id) && terminalTypes.includes(node.type),
    );
    if (kind === "subflow" && terminals.length === 0) {
      problems.push({ message: "Every path must reach a Subflow Output" });
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
 * Publish-time validation (spec §13): schema-valid nodes, exactly one Start (agents) or one
 * Subflow Input (subflows), every path reaches Reply/End or a Subflow Output, no orphans, no
 * cycles except edges marked `loop`. Returns per-node problems so the CRM can badge the cards.
 * Call Subflow cross-flow checks live in `checkSubflowReferences` (they need published targets).
 */
export function validateGraph(graph: FlowGraph, options: ValidationOptions = {}): ValidationResult {
  const kind = options.kind ?? "agent";
  const problems = [
    ...schemaProblems(graph),
    ...structuralProblems(graph, buildAdjacency(graph), kind),
    ...restrictionProblems(graph, options.restrictions),
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
  return [...AGENT_TERMINAL_TYPES, ...SUBFLOW_TERMINAL_TYPES].includes(type);
}
