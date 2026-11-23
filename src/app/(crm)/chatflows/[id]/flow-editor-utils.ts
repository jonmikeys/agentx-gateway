import { type Edge, MarkerType, type Node } from "@xyflow/react";
import dagre from "dagre";
import {
  type FlowEdge,
  type FlowGraph,
  type FlowNode,
  isExecutableNode,
  type NodeType,
} from "@/lib/agents/graph";

export type EditorNodeData = FlowNode["data"];
export type EditorNode = Node<EditorNodeData, NodeType>;
export type EditorEdge = Edge<{ loop?: boolean }>;

/** Matches the fixed card width used by the custom node renderer. */
export const NODE_WIDTH = 232;
export const NODE_HEIGHT = 104;

function dimension(value: number | string | undefined): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function toEditorNodes(graph: FlowGraph): EditorNode[] {
  return graph.nodes.map(
    (node) =>
      ({
        id: node.id,
        type: node.type,
        position: node.position,
        data: node.data,
        parentId: node.parentId,
        zIndex: node.zIndex,
        ...(node.width !== undefined ? { width: node.width } : {}),
        ...(node.height !== undefined ? { height: node.height } : {}),
      }) as EditorNode,
  );
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
    nodes: nodes.map((node) => {
      const width = dimension(node.width) ?? dimension(node.style?.width);
      const height = dimension(node.height) ?? dimension(node.style?.height);
      return {
        id: node.id,
        type: node.type,
        position: { x: Math.round(node.position.x), y: Math.round(node.position.y) },
        data: node.data,
        ...(node.parentId ? { parentId: node.parentId } : {}),
        ...(node.zIndex !== undefined ? { zIndex: node.zIndex } : {}),
        ...(width !== undefined ? { width: Math.round(width) } : {}),
        ...(height !== undefined ? { height: Math.round(height) } : {}),
      } as FlowNode;
    }),
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
  // Notes, group frames and grouped children keep their positions; only free executable nodes lay out.
  const layoutable = nodes.filter((node) => isExecutableNode(node) && !node.parentId);
  if (layoutable.length === 0) return nodes;
  const layoutIds = new Set(layoutable.map((node) => node.id));
  const graph = new dagre.graphlib.Graph();
  graph.setDefaultEdgeLabel(() => ({}));
  graph.setGraph({
    rankdir: options.direction ?? "LR",
    nodesep: 56,
    ranksep: 130,
    marginx: 24,
    marginy: 24,
  });
  for (const node of layoutable) graph.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  for (const edge of edges) {
    if (!layoutIds.has(edge.source) || !layoutIds.has(edge.target)) continue;
    graph.setEdge(edge.source, edge.target);
  }
  dagre.layout(graph);
  return nodes.map((node) => {
    if (!layoutIds.has(node.id)) return node;
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
