import type { FlowEdge, FlowGraph, FlowNode } from "@/lib/agents/graph";

/**
 * View-only structural diff used by "Compare with draft" in version history. The base is the
 * published version and the compare graph is the draft, so `added` entries exist in the draft
 * only. Positions are ignored; changing a node's content or an edge's endpoints marks it changed.
 */
export type DiffStatus = "added" | "removed" | "changed";

export interface DiffEntry {
  id: string;
  title: string;
  kind: string;
}

export interface GraphDiff {
  nodes: Map<string, DiffStatus>;
  edges: Map<string, DiffStatus>;
  addedNodes: DiffEntry[];
  removedNodes: DiffEntry[];
  changedNodes: DiffEntry[];
  addedEdges: DiffEntry[];
  removedEdges: DiffEntry[];
  changedEdges: DiffEntry[];
  empty: boolean;
}

function nodeSignature(node: FlowNode): string {
  return JSON.stringify({ type: node.type, data: node.data });
}

function edgeSignature(edge: FlowEdge): string {
  return JSON.stringify({
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle ?? null,
    targetHandle: edge.targetHandle ?? null,
    label: edge.label ?? "",
    data: edge.data ?? null,
  });
}

function nodeEntry(node: FlowNode): DiffEntry {
  return { id: node.id, title: node.data.title, kind: node.type };
}

function edgeEntry(edge: FlowEdge): DiffEntry {
  const handle = edge.sourceHandle ? ` (${edge.sourceHandle})` : "";
  return { id: edge.id, title: `${edge.source}${handle} → ${edge.target}`, kind: "edge" };
}

export function diffGraphs(base: FlowGraph, compare: FlowGraph): GraphDiff {
  const nodes = new Map<string, DiffStatus>();
  const edges = new Map<string, DiffStatus>();
  const addedNodes: DiffEntry[] = [];
  const removedNodes: DiffEntry[] = [];
  const changedNodes: DiffEntry[] = [];
  const addedEdges: DiffEntry[] = [];
  const removedEdges: DiffEntry[] = [];
  const changedEdges: DiffEntry[] = [];

  const baseNodes = new Map(base.nodes.map((node) => [node.id, node]));
  const compareNodes = new Map(compare.nodes.map((node) => [node.id, node]));

  for (const node of compare.nodes) {
    const previous = baseNodes.get(node.id);
    if (!previous) {
      nodes.set(node.id, "added");
      addedNodes.push(nodeEntry(node));
    } else if (nodeSignature(previous) !== nodeSignature(node)) {
      nodes.set(node.id, "changed");
      changedNodes.push(nodeEntry(node));
    }
  }
  for (const node of base.nodes) {
    if (compareNodes.has(node.id)) continue;
    nodes.set(node.id, "removed");
    removedNodes.push(nodeEntry(node));
  }

  const baseEdges = new Map(base.edges.map((edge) => [edge.id, edge]));
  const compareEdges = new Map(compare.edges.map((edge) => [edge.id, edge]));

  for (const edge of compare.edges) {
    const previous = baseEdges.get(edge.id);
    if (!previous) {
      edges.set(edge.id, "added");
      addedEdges.push(edgeEntry(edge));
    } else if (edgeSignature(previous) !== edgeSignature(edge)) {
      edges.set(edge.id, "changed");
      changedEdges.push(edgeEntry(edge));
    }
  }
  for (const edge of base.edges) {
    if (compareEdges.has(edge.id)) continue;
    edges.set(edge.id, "removed");
    removedEdges.push(edgeEntry(edge));
  }

  return {
    nodes,
    edges,
    addedNodes,
    removedNodes,
    changedNodes,
    addedEdges,
    removedEdges,
    changedEdges,
    empty:
      addedNodes.length === 0 &&
      removedNodes.length === 0 &&
      changedNodes.length === 0 &&
      addedEdges.length === 0 &&
      removedEdges.length === 0 &&
      changedEdges.length === 0,
  };
}
