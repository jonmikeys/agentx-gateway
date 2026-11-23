import {
  type EditorNode,
  NODE_HEIGHT,
  NODE_WIDTH,
} from "@/app/(crm)/chatflows/[id]/flow-editor-utils";
import type { GroupNodeData } from "@/lib/agents/graph";

/** Padding between a group frame and the nodes it wraps. */
export const GROUP_PADDING = 32;
export const GROUP_MIN_WIDTH = 260;
export const GROUP_MIN_HEIGHT = 180;

function sizeOf(node: EditorNode): { width: number; height: number } {
  return {
    width: node.width ?? NODE_WIDTH,
    height: node.height ?? NODE_HEIGHT,
  };
}

/** New id for a group or note; falls back when `crypto.randomUUID` is unavailable. */
export function canvasNodeId(prefix: string): string {
  const suffix =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().slice(0, 8)
      : `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
  return `${prefix}_${suffix}`;
}

export function selectedIds(nodes: EditorNode[]): Set<string> {
  return new Set(nodes.filter((node) => node.selected).map((node) => node.id));
}

/**
 * Wraps the selected free nodes in a titled group frame (a React Flow parent node). Children keep
 * their absolute screen position by switching to parent-relative coordinates. Groups never nest.
 */
export function groupNodes(
  nodes: EditorNode[],
  ids: Set<string>,
  groupId: string,
  title = "Group",
): EditorNode[] {
  const selected = nodes.filter(
    (node) => ids.has(node.id) && node.type !== "group" && !node.parentId,
  );
  if (selected.length === 0) return nodes;

  const boxes = selected.map((node) => {
    const { width, height } = sizeOf(node);
    return {
      left: node.position.x,
      top: node.position.y,
      right: node.position.x + width,
      bottom: node.position.y + height,
      width,
      height,
    };
  });
  const minX = Math.min(...boxes.map((box) => box.left));
  const minY = Math.min(...boxes.map((box) => box.top));
  const maxX = Math.max(...boxes.map((box) => box.right));
  const maxY = Math.max(...boxes.map((box) => box.bottom));

  const position = {
    x: Math.round(minX - GROUP_PADDING),
    y: Math.round(minY - GROUP_PADDING),
  };
  const width = Math.max(GROUP_MIN_WIDTH, Math.round(maxX - minX + GROUP_PADDING * 2));
  const height = Math.max(GROUP_MIN_HEIGHT, Math.round(maxY - minY + GROUP_PADDING * 2));

  const group: EditorNode = {
    id: groupId,
    type: "group",
    position,
    width,
    height,
    zIndex: -1,
    selected: true,
    data: { title, color: "grey", collapsed: false } satisfies GroupNodeData,
  } as EditorNode;

  const remaining = nodes
    .filter((node) => !ids.has(node.id))
    .map((node) => ({ ...node, selected: false }));
  const children = selected.map(
    (node) =>
      ({
        ...node,
        parentId: groupId,
        selected: false,
        zIndex: Math.max(0, node.zIndex ?? 0),
        position: {
          x: Math.round(node.position.x - position.x),
          y: Math.round(node.position.y - position.y),
        },
      }) as EditorNode,
  );

  return [...remaining, group, ...children];
}

/** Removes a group frame and returns its children to absolute coordinates. */
export function ungroupNode(nodes: EditorNode[], groupId: string): EditorNode[] {
  const group = nodes.find((node) => node.id === groupId && node.type === "group");
  if (!group) return nodes;
  return nodes
    .filter((node) => node.id !== groupId)
    .map((node) =>
      node.parentId === groupId
        ? ({
            ...node,
            parentId: undefined,
            position: {
              x: Math.round(node.position.x + group.position.x),
              y: Math.round(node.position.y + group.position.y),
            },
          } as EditorNode)
        : node,
    );
}

/** Brings a note to the front (or sends it back) without touching execution order. */
export function adjustLayer(nodes: EditorNode[], nodeId: string, delta: number): EditorNode[] {
  return nodes.map((node) =>
    node.id === nodeId
      ? { ...node, zIndex: Math.max(-100, Math.min(100, (node.zIndex ?? 0) + delta)) }
      : node,
  );
}

/** True when a group node is collapsed; its children are then hidden on the canvas. */
export function collapsedGroupIds(nodes: EditorNode[]): Set<string> {
  const ids = new Set<string>();
  for (const node of nodes) {
    if (node.type !== "group") continue;
    const data = node.data as GroupNodeData;
    if (data.collapsed) ids.add(node.id);
  }
  return ids;
}

export function isCanvasNodeType(type: string | undefined): boolean {
  return type === "note" || type === "group";
}
