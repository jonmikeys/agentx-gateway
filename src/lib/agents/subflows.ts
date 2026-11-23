import type { FlowGraph, FlowKind, FlowNode, SubflowParam } from "@/lib/agents/graph";

/**
 * Pure subflow reference checks shared by publish validation and the unit tests (spec §13).
 * The caller supplies a resolver for the *latest published* version of any flow, so the checks
 * can follow calls across versions without touching the database.
 */

export const MAX_SUBFLOW_DEPTH = 5;

export interface PublishedFlowGraph {
  flowId: string;
  version: number;
  graph: FlowGraph;
  name?: string;
  kind?: FlowKind;
}

export type PublishedFlowResolver = (flowId: string) => PublishedFlowGraph | undefined;

export interface SubflowProblem {
  nodeId?: string;
  nodeTitle?: string;
  message: string;
}

export type CallSubflowNode = Extract<FlowNode, { type: "call_subflow" }>;

export function callSubflowNodes(graph: FlowGraph): CallSubflowNode[] {
  return graph.nodes.filter((node): node is CallSubflowNode => node.type === "call_subflow");
}

/** Distinct subflow ids referenced by Call Subflow nodes, in graph order. */
export function calledSubflowIds(graph: FlowGraph): string[] {
  const ids: string[] = [];
  for (const node of callSubflowNodes(graph)) {
    if (!node.data.subflowId) continue;
    if (!ids.includes(node.data.subflowId)) ids.push(node.data.subflowId);
  }
  return ids;
}

/** Declared parameters of a subflow graph (from its Subflow Input node). */
export function subflowParams(graph: FlowGraph): SubflowParam[] {
  const input = graph.nodes.find((node) => node.type === "subflow_input");
  return input && input.type === "subflow_input" ? input.data.params : [];
}

/** Labels of a subflow graph's Subflow Output nodes. */
export function subflowOutputLabels(graph: FlowGraph): string[] {
  return graph.nodes
    .filter((node): node is Extract<FlowNode, { type: "subflow_output" }> => {
      return node.type === "subflow_output";
    })
    .map((node) => node.data.label);
}

function callNodeProblems(node: CallSubflowNode, target: PublishedFlowGraph): SubflowProblem[] {
  const problems: SubflowProblem[] = [];
  const base = { nodeId: node.id, nodeTitle: node.data.title };

  if (target.kind !== undefined && target.kind !== "subflow") {
    return [{ ...base, message: "Call Subflow must reference a subflow, not an agent" }];
  }

  const params = subflowParams(target.graph);
  const mapped = new Set(node.data.inputs.map((input) => input.name));
  for (const param of params) {
    if (param.required && !mapped.has(param.name)) {
      problems.push({
        ...base,
        message: `Map the required input "${param.name}"`,
      });
    }
  }

  const targetLabels = subflowOutputLabels(target.graph);
  if (targetLabels.length === 0) {
    problems.push({
      ...base,
      message: `Subflow "${target.name ?? target.flowId}" has no Subflow Output`,
    });
  }
  const configured = node.data.outputs.map((output) => output.label);
  if (configured.length === 0) {
    problems.push({ ...base, message: "Add at least one output label" });
  }
  for (const label of configured) {
    if (!targetLabels.includes(label)) {
      problems.push({
        ...base,
        message: `The subflow has no output labelled "${label}"`,
      });
    }
  }
  for (const label of targetLabels) {
    if (!configured.includes(label)) {
      problems.push({
        ...base,
        message: `Add an output for the subflow's "${label}" branch`,
      });
    }
  }
  return problems;
}

interface WalkState {
  problems: SubflowProblem[];
  /** flow id -> depth at which it was first reached, to cap repeated work. */
  seen: Map<string, number>;
}

function walk(
  graph: FlowGraph,
  depth: number,
  rootId: string,
  resolver: PublishedFlowResolver,
  path: string[],
  state: WalkState,
  depthLimit: number,
): void {
  for (const node of callSubflowNodes(graph)) {
    const base = { nodeId: node.id, nodeTitle: node.data.title };
    const targetId = node.data.subflowId;
    if (!targetId) {
      state.problems.push({ ...base, message: "Choose a subflow" });
      continue;
    }
    const target = resolver(targetId);
    if (!target) {
      state.problems.push({
        ...base,
        message: "This subflow is not published yet; publish it first",
      });
      continue;
    }
    if (path.includes(targetId) || targetId === rootId) {
      state.problems.push({
        ...base,
        message: `Subflow call cycle: ${[...path, targetId].join(" -> ")}`,
      });
      continue;
    }
    const nextDepth = depth + 1;
    if (nextDepth > depthLimit) {
      state.problems.push({
        ...base,
        message: `Subflows nest deeper than ${depthLimit} levels`,
      });
      continue;
    }
    const previousDepth = state.seen.get(targetId);
    if (previousDepth !== undefined && previousDepth <= nextDepth) continue;
    state.seen.set(targetId, nextDepth);
    walk(target.graph, nextDepth, rootId, resolver, [...path, targetId], state, depthLimit);
  }
}

/**
 * Validates every Call Subflow node in `graph`: the target is published, required inputs are
 * mapped, output labels match, calls do not cycle (including through published versions) and
 * nesting stays within `depthLimit`.
 */
export function checkSubflowReferences(options: {
  flowId: string;
  graph: FlowGraph;
  resolver: PublishedFlowResolver;
  depthLimit?: number;
}): SubflowProblem[] {
  const { flowId, graph, resolver, depthLimit = MAX_SUBFLOW_DEPTH } = options;
  const problems: SubflowProblem[] = [];
  const state: WalkState = { problems, seen: new Map() };

  for (const node of callSubflowNodes(graph)) {
    if (!node.data.subflowId) {
      problems.push({ nodeId: node.id, nodeTitle: node.data.title, message: "Choose a subflow" });
      continue;
    }
    const target = resolver(node.data.subflowId);
    if (!target) {
      problems.push({
        nodeId: node.id,
        nodeTitle: node.data.title,
        message: "This subflow is not published yet; publish it first",
      });
      continue;
    }
    problems.push(...callNodeProblems(node, target));
  }

  walk(graph, 0, flowId, resolver, [flowId], state, depthLimit);
  return dedupe(problems);
}

function dedupe(problems: SubflowProblem[]): SubflowProblem[] {
  const seen = new Set<string>();
  const result: SubflowProblem[] = [];
  for (const problem of problems) {
    const key = `${problem.nodeId ?? ""}|${problem.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(problem);
  }
  return result;
}
