import {
  type FlowEdge,
  type FlowGraph,
  type FlowNode,
  isExecutableNode,
  type SubflowParam,
  subflowOutputHandle,
} from "@/lib/agents/graph";

/**
 * "Convert group to subflow" (G7b, spec §14). Extracts a visual group's children into a new
 * subflow draft and replaces the group with a Call Subflow node wired to the same neighbours.
 *
 * Pure and DB-free so it can be unit tested: the caller creates the subflow flow, then fills the
 * returned Call Subflow node's `subflowId` with the created flow id.
 */

export interface GroupConversion {
  /** Suggested name for the new subflow flow. */
  subflowName: string;
  /** Draft graph of the extracted subflow (kind `subflow`). */
  subflow: FlowGraph;
  /** Parent graph with the group replaced by a Call Subflow node. */
  parent: FlowGraph;
  /** Id of the Call Subflow node inserted into the parent. */
  callNodeId: string;
  /** Number of declared Subflow Input parameters. */
  paramCount: number;
  /** Branch labels exposed by the Call Subflow node. */
  outputLabels: string[];
}

export type GroupConversionResult =
  | { ok: true; conversion: GroupConversion }
  | { ok: false; error: string };

const MAX_NAME = 60;

/** Turns a human title into a valid variable/label identifier (`[A-Za-z_][A-Za-z0-9_]*`). */
function identifier(raw: string, fallback: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  const base = cleaned || fallback;
  return /^[a-z_]/.test(base) ? base : `v_${base}`;
}

function unique(base: string, used: Set<string>): string {
  let name = base.slice(0, MAX_NAME);
  let counter = 2;
  while (used.has(name)) {
    name = `${base.slice(0, MAX_NAME - 3)}_${counter}`;
    counter += 1;
  }
  used.add(name);
  return name;
}

function freshId(prefix: string, used: Set<string>): string {
  let index = 1;
  while (used.has(`${prefix}_${index}`)) index += 1;
  const id = `${prefix}_${index}`;
  used.add(id);
  return id;
}

function edgeId(source: string, target: string, used: Set<string>): string {
  const base = `e_${source}_${target}`.slice(0, 110);
  let id = base;
  let counter = 2;
  while (used.has(id)) {
    id = `${base.slice(0, 112)}_${counter}`;
    counter += 1;
  }
  used.add(id);
  return id;
}

/** The variable a node stores its output in, when it has one. */
function outputVariableOf(node: FlowNode | undefined): string | undefined {
  if (!node) return undefined;
  const data = node.data as { outputVariable?: unknown };
  return typeof data.outputVariable === "string" && data.outputVariable
    ? data.outputVariable
    : undefined;
}

export interface ConvertGroupOptions {
  /** Overrides the suggested subflow name (defaults to the group title). */
  subflowName?: string;
  /** Fixed ids make the result deterministic in tests. */
  callNodeId?: string;
}

export function convertGroupToSubflow(
  graph: FlowGraph,
  groupId: string,
  options: ConvertGroupOptions = {},
): GroupConversionResult {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const group = byId.get(groupId);
  if (group?.type !== "group") {
    return { ok: false, error: "Select a group to convert." };
  }

  const children = graph.nodes.filter((node) => node.parentId === groupId);
  const executable = children.filter(isExecutableNode);
  if (executable.length === 0) {
    return { ok: false, error: "This group has no nodes to move into a subflow." };
  }
  if (executable.some((node) => node.type === "start")) {
    return {
      ok: false,
      error:
        "A group that contains a Start node cannot be converted. Move the Start node out first.",
    };
  }
  if (executable.some((node) => node.type === "end")) {
    return {
      ok: false,
      error:
        "A group that contains an End node cannot be converted. Subflows end at a Subflow Output.",
    };
  }

  const inside = new Set(children.map((node) => node.id));
  const isInside = (id: string) => inside.has(id) || id === groupId;
  const inbound = graph.edges.filter((edge) => isInside(edge.target) && !isInside(edge.source));
  const outbound = graph.edges.filter((edge) => isInside(edge.source) && !isInside(edge.target));

  if (inbound.length === 0) {
    return { ok: false, error: "Connect the group to an upstream node before converting." };
  }
  if (outbound.length === 0) {
    return { ok: false, error: "Connect at least one output from the group before converting." };
  }

  // One Subflow Input parameter per distinct upstream value.
  const usedParams = new Set<string>();
  const paramBySource = new Map<string, SubflowParam>();
  const inputs: { name: string; value: string }[] = [];
  for (const edge of inbound) {
    const key = `${edge.source}|${edge.sourceHandle ?? "out"}`;
    if (paramBySource.has(key)) continue;
    const source = byId.get(edge.source);
    const base = outputVariableOf(source) ?? identifier(source?.data.title ?? "input", "input");
    const param: SubflowParam = { name: unique(base, usedParams), type: "string", required: true };
    paramBySource.set(key, param);
    inputs.push({ name: param.name, value: `{{nodes.${edge.source}.output}}` });
  }

  // One Subflow Output per distinct exit destination.
  const usedLabels = new Set<string>();
  const usedVars = new Set<string>();
  const exitByTarget = new Map<string, { label: string; variable: string }>();
  const outputs: { label: string; variable: string }[] = [];
  for (const edge of outbound) {
    if (exitByTarget.has(edge.target)) continue;
    const target = byId.get(edge.target);
    const label = unique(identifier(target?.data.title ?? "output", "output"), usedLabels);
    const variable = unique(identifier(label, "result"), usedVars);
    exitByTarget.set(edge.target, { label, variable });
    outputs.push({ label, variable });
  }

  // --- Build the subflow draft ---------------------------------------------------------------
  const subflowUsed = new Set<string>();
  const absolute = children.map((node) => ({
    node,
    x: node.position.x + group.position.x,
    y: node.position.y + group.position.y,
  }));
  const minX = Math.min(...absolute.map((entry) => entry.x));
  const minY = Math.min(...absolute.map((entry) => entry.y));
  const maxX = Math.max(...absolute.map((entry) => entry.x + (entry.node.width ?? 232)));

  const inputId = freshId("subflow_input", subflowUsed);
  const inputNode = {
    id: inputId,
    type: "subflow_input",
    position: { x: Math.round(minX - 300), y: Math.round(minY) },
    data: { title: "Input", params: [...paramBySource.values()] },
  } as FlowNode;

  const outputNodeByTarget = new Map<string, FlowNode>();
  const outputNodes: FlowNode[] = [];
  let outputIndex = 0;
  for (const [targetId, entry] of exitByTarget) {
    const id = freshId("subflow_output", subflowUsed);
    const node = {
      id,
      type: "subflow_output",
      position: { x: Math.round(maxX + 300), y: Math.round(minY + outputIndex * 180) },
      data: { title: entry.label, label: entry.label, values: [] },
    } as FlowNode;
    outputNodeByTarget.set(targetId, node);
    outputNodes.push(node);
    outputIndex += 1;
  }

  const movedNodes: FlowNode[] = absolute.map(({ node, x, y }) => {
    const { parentId: _parentId, ...rest } = node;
    return {
      ...rest,
      position: { x: Math.round(x - minX + 40), y: Math.round(y - minY + 40) },
    } as FlowNode;
  });

  const subflowEdgeUsed = new Set<string>();
  const subflowEdges: FlowEdge[] = [];
  for (const edge of graph.edges) {
    if (!inside.has(edge.source) || !inside.has(edge.target)) continue;
    subflowEdges.push(edge);
    subflowEdgeUsed.add(edge.id);
  }
  for (const edge of inbound) {
    if (!inside.has(edge.target)) continue;
    subflowEdges.push({
      id: edgeId(inputId, edge.target, subflowEdgeUsed),
      source: inputId,
      target: edge.target,
      sourceHandle: "out",
      targetHandle: edge.targetHandle ?? undefined,
    });
  }
  for (const edge of outbound) {
    if (!inside.has(edge.source)) continue;
    const outputNode = outputNodeByTarget.get(edge.target);
    if (!outputNode) continue;
    subflowEdges.push({
      id: edgeId(edge.source, outputNode.id, subflowEdgeUsed),
      source: edge.source,
      target: outputNode.id,
      sourceHandle: edge.sourceHandle ?? "out",
    });
  }

  const subflow: FlowGraph = {
    nodes: [inputNode, ...movedNodes, ...outputNodes],
    edges: subflowEdges,
  };

  // --- Rewrite the parent graph --------------------------------------------------------------
  const callNodeId =
    options.callNodeId ?? freshId("call_subflow", new Set(graph.nodes.map((n) => n.id)));
  const subflowName = (options.subflowName ?? group.data.title ?? "Subflow").trim() || "Subflow";
  const callNode = {
    id: callNodeId,
    type: "call_subflow",
    position: group.position,
    data: {
      title: subflowName,
      subflowId: null,
      subflowName,
      inputs,
      outputs,
    },
  } as FlowNode;

  const removed = new Set([groupId, ...inside]);
  const parentNodes = graph.nodes.filter((node) => !removed.has(node.id));
  parentNodes.push(callNode);

  const parentEdges: FlowEdge[] = [];
  const seenOutbound = new Set<string>();
  for (const edge of graph.edges) {
    const fromInside = isInside(edge.source);
    const toInside = isInside(edge.target);
    if (fromInside && toInside) continue;
    if (toInside) {
      parentEdges.push({ ...edge, target: callNodeId, targetHandle: undefined });
      continue;
    }
    if (fromInside) {
      const exit = exitByTarget.get(edge.target);
      if (!exit) continue;
      const key = `${exit.label}|${edge.target}`;
      if (seenOutbound.has(key)) continue;
      seenOutbound.add(key);
      parentEdges.push({
        ...edge,
        source: callNodeId,
        sourceHandle: subflowOutputHandle(exit.label),
        targetHandle: edge.targetHandle ?? undefined,
      });
      continue;
    }
    parentEdges.push(edge);
  }

  return {
    ok: true,
    conversion: {
      subflowName,
      subflow,
      parent: { nodes: parentNodes, edges: parentEdges },
      callNodeId,
      paramCount: paramBySource.size,
      outputLabels: outputs.map((output) => output.label),
    },
  };
}
