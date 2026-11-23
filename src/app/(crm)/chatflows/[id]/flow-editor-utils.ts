import { type Edge, MarkerType, type Node } from "@xyflow/react";
import dagre from "dagre";
import type { FlowEdge, FlowGraph, FlowNode, NodeType } from "@/lib/agents/graph";

export type EditorNodeData = FlowNode["data"];
export type EditorNode = Node<EditorNodeData, NodeType>;
export type EditorEdge = Edge<{ loop?: boolean }>;

/** Matches the fixed card width used by the custom node renderer. */
export const NODE_WIDTH = 232;
export const NODE_HEIGHT = 104;

export function toEditorNodes(graph: FlowGraph): EditorNode[] {
  return graph.nodes.map((node) => ({
    id: node.id,
    type: node.type,
    position: node.position,
    data: node.data,
  })) as EditorNode[];
}

export function toEditorEdges(graph: FlowGraph): EditorEdge[] {
  return graph.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle ?? undefined,
    targetHandle: edge.targetHandle ?? undefined,
    label: edge.label,
    data: edge.data,
    type: "smoothstep",
    markerEnd: { type: MarkerType.ArrowClosed },
  }));
}

/** Strips React Flow runtime fields so only the persisted graph shape is saved. */
export function toFlowGraph(nodes: EditorNode[], edges: EditorEdge[]): FlowGraph {
  return {
    nodes: nodes.map(
      (node) =>
        ({
          id: node.id,
          type: node.type,
          position: { x: Math.round(node.position.x), y: Math.round(node.position.y) },
          data: node.data,
        }) as FlowNode,
    ),
    edges: edges.map(
      (edge) =>
        ({
          id: edge.id,
          source: edge.source,
          target: edge.target,
          sourceHandle: edge.sourceHandle ?? null,
          targetHandle: edge.targetHandle ?? null,
          ...(edge.label ? { label: String(edge.label) } : {}),
          ...(edge.data ? { data: edge.data } : {}),
        }) as FlowEdge,
    ),
  };
}

/** Dagre layout preserving node ids and data; enough separation that smoothstep edges route between cards. */
export function autoLayout(
  nodes: EditorNode[],
  edges: EditorEdge[],
  options: { direction?: "LR" | "TB" } = {},
): EditorNode[] {
  if (nodes.length === 0) return nodes;
  const graph = new dagre.graphlib.Graph();
  graph.setDefaultEdgeLabel(() => ({}));
  graph.setGraph({
    rankdir: options.direction ?? "LR",
    nodesep: 56,
    ranksep: 130,
    marginx: 24,
    marginy: 24,
  });
  for (const node of nodes) graph.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  for (const edge of edges) {
    if (
      !nodes.some((node) => node.id === edge.source) ||
      !nodes.some((node) => node.id === edge.target)
    ) {
      continue;
    }
    graph.setEdge(edge.source, edge.target);
  }
  dagre.layout(graph);
  return nodes.map((node) => {
    const placed = graph.node(node.id);
    return {
      ...node,
      position: {
        x: Math.round((placed?.x ?? 0) - NODE_WIDTH / 2),
        y: Math.round((placed?.y ?? 0) - NODE_HEIGHT / 2),
      },
    };
  });
}
