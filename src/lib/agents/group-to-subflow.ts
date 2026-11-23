import {
  type FlowEdge,
  type FlowGraph,
  type FlowNode,
  isExecutableNode,
  type SubflowParam,
  subflowOutputHandle,
} from "@/lib/agents/graph";
import { TEMPLATE_PATTERN } from "@/lib/agents/templates";

/**
 * "Convert group to subflow" (G7b, spec §14). Extracts a visual group's children into a new
 * subflow draft and replaces the group with a Call Subflow node wired to the same neighbours.
 *
 * A subflow only sees its own params as `vars`, so the conversion rewires data both ways:
 * - Imports: every `{{nodes.<outside>…}}` reference, and every `{{vars.<name>}}` reference whose
 *   variable is not written inside the group, becomes a Subflow Input param. The Call Subflow
 *   node maps it from the parent's original expression, and the moved node reads `{{vars.<param>}}`.
 * - Exports: every reference from the remaining parent nodes to a moved node
 *   (`{{nodes.<inside>…}}`), or to a variable written inside the group, becomes a return value
 *   of every Subflow Output. The parent reads it from the Call Subflow's result variable.
 *
 * Pure and DB-free, so it can be unit tested. The caller creates the subflow flow, then fills the
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
  /** Caller variable that receives the subflow's return values. */
  resultVariable: string;
  /** Names of the values every Subflow Output returns. */
  exportedValues: string[];
}

export type GroupConversionResult =
  | { ok: true; conversion: GroupConversion }
  | { ok: false; error: string };

export interface ConvertGroupOptions {
  /** Overrides the suggested subflow name (defaults to the group title). */
  subflowName?: string;
  /** Fixed ids make the result deterministic in tests. */
  callNodeId?: string;
}

const MAX_IDENTIFIER = 64;

/** Turns free text into a valid variable/label identifier (`[a-z_][a-z0-9_]*`). */
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
  let name = base.slice(0, MAX_IDENTIFIER);
  let counter = 2;
  while (used.has(name)) {
    name = `${base.slice(0, MAX_IDENTIFIER - 4)}_${counter}`;
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
    id = `${base}_${counter}`;
    counter += 1;
  }
  used.add(id);
  return id;
}

/** Applies `transform` to every string inside a value (deep, plain objects and arrays). */
function mapStrings<T>(value: T, transform: (text: string) => string): T {
  if (typeof value === "string") return transform(value) as T;
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, transform)) as T;
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) result[key] = mapStrings(item, transform);
    return result as T;
  }
  return value;
}

/** Every `{{…}}` path used anywhere in a node's data. */
function referencesIn(node: FlowNode): string[] {
  const paths: string[] = [];
  mapStrings(node.data, (text) => {
    for (const match of text.matchAll(TEMPLATE_PATTERN)) {
      const path = match[1]?.trim();
      if (path) paths.push(path);
    }
    return text;
  });
  return paths;
}

/** Rewrites the `{{path}}` references listed in `replacements` and leaves every other one. */
function rewriteReferences(node: FlowNode, replacements: Map<string, string>): FlowNode {
  if (replacements.size === 0) return node;
  const data = mapStrings(node.data, (text) =>
    text.replace(TEMPLATE_PATTERN, (full, rawPath: string) => {
      const replacement = replacements.get(rawPath.trim());
      return replacement === undefined ? full : `{{${replacement}}}`;
    }),
  );
  return { ...node, data } as FlowNode;
}

/** Variables nodes write: output variables, Set Variable keys and Call Subflow result vars. */
function writtenVariables(nodes: FlowNode[]): Set<string> {
  const names = new Set<string>();
  for (const node of nodes) {
    const data = node.data as {
      outputVariable?: unknown;
      assignments?: { key?: unknown }[];
      outputs?: { variable?: unknown }[];
    };
    if (typeof data.outputVariable === "string" && data.outputVariable) {
      names.add(data.outputVariable);
    }
    for (const assignment of Array.isArray(data.assignments) ? data.assignments : []) {
      if (typeof assignment.key === "string") names.add(assignment.key);
    }
    if (node.type === "call_subflow") {
      for (const output of Array.isArray(data.outputs) ? data.outputs : []) {
        if (typeof output.variable === "string") names.add(output.variable);
      }
    }
  }
  return names;
}

/** Readable name for a reference path, e.g. `nodes.n3.output.city` -> `<n3 title>_city`. */
function referenceLabel(path: string, byId: Map<string, FlowNode>): string {
  const [root, first, ...rest] = path.split(".");
  if (root === "nodes") {
    const tail = rest[0] === "output" ? rest.slice(1) : rest;
    return [byId.get(first ?? "")?.data.title ?? first ?? "value", ...tail].join("_");
  }
  return [first ?? "value", ...rest].join("_");
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
  if (children.some((node) => node.type === "group")) {
    return {
      ok: false,
      error: "Ungroup the nested group first; groups inside groups cannot be converted.",
    };
  }
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
  // A subflow has one Subflow Input, which starts every branch it is connected to. Several entry
  // nodes would therefore run branches that the original flow only ran one at a time.
  const entryIds = [...new Set(inbound.map((edge) => edge.target))];
  const entryId = entryIds[0];
  if (entryIds.length !== 1 || !entryId || !inside.has(entryId)) {
    return {
      ok: false,
      error:
        "The group must have exactly one entry node: every connection into it has to reach the same node.",
    };
  }

  const outsideNodes = graph.nodes.filter((node) => !isInside(node.id));
  const writtenInside = writtenVariables(executable);
  const subflowName = (options.subflowName ?? group.data.title ?? "Subflow").trim() || "Subflow";

  // --- Imports: references the moved nodes make to the parent ---------------------------------
  const usedParams = new Set<string>();
  const params: SubflowParam[] = [];
  const inputs: { name: string; value: string }[] = [];
  const importByPath = new Map<string, string>();
  for (const node of executable) {
    for (const path of referencesIn(node)) {
      if (importByPath.has(path)) continue;
      const [root, first] = path.split(".");
      if (!first) continue;
      const isImport =
        (root === "nodes" && !inside.has(first)) || (root === "vars" && !writtenInside.has(first));
      if (!isImport) continue;
      const name = unique(identifier(referenceLabel(path, byId), "input"), usedParams);
      importByPath.set(path, `vars.${name}`);
      params.push({ name, type: "string", required: true });
      inputs.push({ name, value: `{{${path}}}` });
    }
  }

  // --- Exports: references the remaining parent nodes make to the moved nodes -----------------
  const exportPaths: string[] = [];
  for (const node of outsideNodes) {
    for (const path of referencesIn(node)) {
      if (exportPaths.includes(path)) continue;
      const [root, first] = path.split(".");
      if (!first) continue;
      const refersInside =
        (root === "nodes" && inside.has(first)) || (root === "vars" && writtenInside.has(first));
      if (refersInside) exportPaths.push(path);
    }
  }
  const usedExportNames = new Set<string>();
  const exports = exportPaths.map((path) => ({
    path,
    name: unique(identifier(referenceLabel(path, byId), "value"), usedExportNames),
  }));
  const resultVariable = unique(
    identifier(`${subflowName}_result`, "subflow_result"),
    new Set([...writtenVariables(outsideNodes), ...writtenInside]),
  );
  // The Call Subflow stores a single returned value as-is, and several as an object.
  const exportReplacements = new Map<string, string>(
    exports.map((entry) => [
      entry.path,
      exports.length === 1 ? `vars.${resultVariable}` : `vars.${resultVariable}.${entry.name}`,
    ]),
  );
  const returnValues = exports.map((entry) => ({ name: entry.name, value: `{{${entry.path}}}` }));

  // --- Outputs: one Subflow Output per distinct exit destination -------------------------------
  const usedLabels = new Set<string>();
  const exitByTarget = new Map<string, string>();
  for (const edge of outbound) {
    if (exitByTarget.has(edge.target)) continue;
    const title = byId.get(edge.target)?.data.title ?? "output";
    exitByTarget.set(edge.target, unique(identifier(title, "output"), usedLabels));
  }
  const outputs = [...exitByTarget.values()].map((label) => ({ label, variable: resultVariable }));

  // --- Build the subflow draft -----------------------------------------------------------------
  const subflowIds = new Set(children.map((node) => node.id));
  const absolute = children.map((node) => ({
    node,
    x: node.position.x + group.position.x,
    y: node.position.y + group.position.y,
  }));
  const minX = Math.min(...absolute.map((entry) => entry.x));
  const minY = Math.min(...absolute.map((entry) => entry.y));
  const maxX = Math.max(...absolute.map((entry) => entry.x + (entry.node.width ?? 232)));
  const offsetX = 340;

  const inputId = freshId("subflow_input", subflowIds);
  const inputNode = {
    id: inputId,
    type: "subflow_input",
    position: { x: 40, y: 40 },
    data: { title: "Input", params },
  } as FlowNode;

  const outputNodeByTarget = new Map<string, FlowNode>();
  let outputIndex = 0;
  for (const [targetId, label] of exitByTarget) {
    outputNodeByTarget.set(targetId, {
      id: freshId("subflow_output", subflowIds),
      type: "subflow_output",
      position: { x: Math.round(maxX - minX + offsetX * 2), y: Math.round(40 + outputIndex * 180) },
      data: { title: label, label, values: returnValues },
    } as FlowNode);
    outputIndex += 1;
  }

  const movedNodes: FlowNode[] = absolute.map(({ node, x, y }) => {
    const { parentId: _parentId, ...rest } = node;
    const moved = {
      ...rest,
      position: { x: Math.round(x - minX + offsetX), y: Math.round(y - minY + 40) },
    } as FlowNode;
    return isExecutableNode(node) ? rewriteReferences(moved, importByPath) : moved;
  });

  const subflowEdgeIds = new Set<string>();
  const subflowEdges: FlowEdge[] = [];
  for (const edge of graph.edges) {
    if (!inside.has(edge.source) || !inside.has(edge.target)) continue;
    subflowEdges.push(edge);
    subflowEdgeIds.add(edge.id);
  }
  subflowEdges.push({
    id: edgeId(inputId, entryId, subflowEdgeIds),
    source: inputId,
    target: entryId,
    sourceHandle: "out",
  });
  const seenExitEdges = new Set<string>();
  for (const edge of outbound) {
    const outputNode = outputNodeByTarget.get(edge.target);
    if (!outputNode || !inside.has(edge.source)) continue;
    const handle = edge.sourceHandle ?? "out";
    const key = `${edge.source}|${handle}|${outputNode.id}`;
    if (seenExitEdges.has(key)) continue;
    seenExitEdges.add(key);
    subflowEdges.push({
      id: edgeId(edge.source, outputNode.id, subflowEdgeIds),
      source: edge.source,
      target: outputNode.id,
      sourceHandle: handle,
    });
  }

  const subflow: FlowGraph = {
    nodes: [inputNode, ...movedNodes, ...outputNodeByTarget.values()],
    edges: subflowEdges,
  };

  // --- Rewrite the parent graph ----------------------------------------------------------------
  const callNodeId =
    options.callNodeId ?? freshId("call_subflow", new Set(graph.nodes.map((node) => node.id)));
  const callNode = {
    id: callNodeId,
    type: "call_subflow",
    position: group.position,
    data: { title: subflowName, subflowId: null, subflowName, inputs, outputs },
  } as FlowNode;

  const parentNodes = outsideNodes.map((node) =>
    isExecutableNode(node) ? rewriteReferences(node, exportReplacements) : node,
  );
  parentNodes.push(callNode);

  const parentEdges: FlowEdge[] = [];
  const seenInbound = new Set<string>();
  const seenOutbound = new Set<string>();
  for (const edge of graph.edges) {
    const fromInside = isInside(edge.source);
    const toInside = isInside(edge.target);
    if (fromInside && toInside) continue;
    if (toInside) {
      const key = `${edge.source}|${edge.sourceHandle ?? "out"}`;
      if (seenInbound.has(key)) continue;
      seenInbound.add(key);
      parentEdges.push({ ...edge, target: callNodeId, targetHandle: undefined });
      continue;
    }
    if (fromInside) {
      const label = exitByTarget.get(edge.target);
      if (!label) continue;
      const key = `${label}|${edge.target}`;
      if (seenOutbound.has(key)) continue;
      seenOutbound.add(key);
      parentEdges.push({ ...edge, source: callNodeId, sourceHandle: subflowOutputHandle(label) });
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
      paramCount: params.length,
      outputLabels: outputs.map((output) => output.label),
      resultVariable,
      exportedValues: exports.map((entry) => entry.name),
    },
  };
}
