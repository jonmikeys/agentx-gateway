"use client";

import { Handle, type NodeProps, NodeResizer, Position } from "@xyflow/react";
import { ChevronDown, ChevronRight, Ellipsis, Ungroup } from "lucide-react";
import { useEditorUi } from "@/app/(crm)/chatflows/[id]/editor-context";
import { GROUP_MIN_HEIGHT, GROUP_MIN_WIDTH } from "@/app/(crm)/chatflows/[id]/flow-canvas-ops";
import type { EditorNode } from "@/app/(crm)/chatflows/[id]/flow-editor-utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { GroupNodeData } from "@/lib/agents/graph";
import { cn } from "@/lib/utils";

/** Visual group frame (React Flow parent node). Purely cosmetic: the runtime ignores it. */
export function GroupNode({ id, data, selected }: NodeProps<EditorNode>) {
  const group = data as GroupNodeData;
  const { groupChildCount, onToggleCollapse, onUpdateNodeData, onConvertGroup } = useEditorUi();
  const count = groupChildCount(id);

  return (
    <div
      data-testid={`flow-group-${id}`}
      data-node-type="group"
      className={cn(
        "h-full w-full rounded-lg border-2 border-dashed border-note-grey-border bg-note-grey/40",
        group.collapsed && "border-solid bg-card shadow-sm",
        selected && "ring-2 ring-ring",
      )}
    >
      {group.collapsed ? (
        <div className="flex h-full w-full items-center gap-2 px-3 text-xs font-semibold">
          <button
            type="button"
            className="nodrag rounded-sm p-0.5 hover:bg-accent"
            aria-label={`Expand group ${group.title}`}
            onClick={() => onToggleCollapse(id)}
          >
            <ChevronRight className="size-3.5" />
          </button>
          <span className="min-w-0 truncate">{group.title}</span>
          <span className="text-muted-foreground">{count}</span>
          <Handle
            type="target"
            position={Position.Left}
            className="!size-2.5 !border-2 !border-background !bg-muted-foreground"
          />
          <Handle
            type="source"
            position={Position.Right}
            className="!size-2.5 !border-2 !border-background !bg-primary"
          />
        </div>
      ) : (
        <>
          <NodeResizer
            minWidth={GROUP_MIN_WIDTH}
            minHeight={GROUP_MIN_HEIGHT}
            isVisible={selected}
            lineClassName="border-ring"
            handleClassName="bg-ring"
          />
          <div className="flex items-center gap-2 px-3 py-1.5">
            <button
              type="button"
              className="nodrag rounded-sm p-0.5 hover:bg-accent"
              aria-label={`Collapse group ${group.title}`}
              onClick={() => onToggleCollapse(id)}
            >
              <ChevronDown className="size-3.5" />
            </button>
            <input
              aria-label="Group title"
              className="nodrag nopan min-w-0 flex-1 rounded-sm bg-transparent text-xs font-semibold outline-none focus:bg-background/40"
              value={group.title}
              onChange={(event) => onUpdateNodeData(id, { title: event.target.value })}
            />
            <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
              <Ungroup className="size-3" />
              {count}
            </span>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="nodrag rounded-sm p-0.5 hover:bg-accent"
                  aria-label={`Group actions for ${group.title}`}
                  onPointerDown={(event) => event.stopPropagation()}
                >
                  <Ellipsis className="size-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuItem
                  aria-label="Convert group to subflow"
                  onSelect={() => onConvertGroup(id)}
                >
                  Convert group to subflow
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </>
      )}
    </div>
  );
}
