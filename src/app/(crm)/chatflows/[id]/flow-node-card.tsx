"use client";

import { Handle, type NodeProps, Position } from "@xyflow/react";
import {
  CircleAlert,
  Database,
  GitBranch,
  type LucideIcon,
  MessageSquare,
  Play,
  Sparkles,
  Square,
  Variable,
  Webhook,
  Wrench,
} from "lucide-react";
import { useEditorUi } from "@/app/(crm)/chatflows/[id]/editor-context";
import type { EditorNode } from "@/app/(crm)/chatflows/[id]/flow-editor-utils";
import { Badge } from "@/components/ui/badge";
import { type FlowNode, type NodeType, nodeHandles, summarizeNode } from "@/lib/agents/graph";
import { cn } from "@/lib/utils";

const icons: Record<NodeType, LucideIcon> = {
  start: Play,
  llm: Sparkles,
  router: GitBranch,
  set_variable: Variable,
  webhook: Webhook,
  memory: Database,
  mcp_tool: Wrench,
  reply: MessageSquare,
  end: Square,
  subflow_input: Play,
  subflow_output: Square,
  call_subflow: GitBranch,
};

/** Custom React Flow card: icon, editable title, summary, dynamic Router handles, error handles. */
export function FlowNodeCard({ id, type, data, selected }: NodeProps<EditorNode>) {
  const { problems, runningNodeId, traceNodeId, nodeBadges, onRename } = useEditorUi();
  const badge = nodeBadges?.get(id);
  const Icon = icons[(type ?? "start") as NodeType];
  const node = { id, type, position: { x: 0, y: 0 }, data } as FlowNode;
  const handles = nodeHandles(node);
  const nodeProblems = problems.get(id) ?? [];
  const running = runningNodeId === id;
  const traced = traceNodeId === id;
  const nonErrorHandles = handles.filter((handle) => handle.kind !== "error");
  const errorHandle = handles.find((handle) => handle.kind === "error");

  return (
    <div
      data-testid={`flow-node-${id}`}
      data-node-type={type}
      className={cn(
        "relative w-[232px] rounded-lg border bg-card text-card-foreground shadow-sm transition-shadow",
        selected && "ring-2 ring-ring",
        running && "ring-2 ring-primary",
        traced && !running && "ring-2 ring-foreground/60",
        nodeProblems.length > 0 && "border-destructive/60",
      )}
    >
      {type !== "start" && type !== "subflow_input" && (
        <Handle
          type="target"
          position={Position.Left}
          className="!size-2.5 !border-2 !border-background !bg-muted-foreground"
        />
      )}
      <div className="flex items-start gap-2 px-3 pt-2.5">
        <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-muted">
          <Icon className="size-3.5" />
        </span>
        <input
          aria-label={`Title of ${data.title}`}
          className="nodrag nopan w-full min-w-0 rounded-sm bg-transparent text-sm font-medium outline-none focus:bg-accent focus:px-1"
          value={data.title}
          onChange={(event) => onRename(id, event.target.value)}
          onPointerDown={(event) => event.stopPropagation()}
        />
        {nodeProblems.length > 0 && (
          <span
            role="img"
            title={nodeProblems.map((problem) => problem.message).join("\n")}
            aria-label={`${nodeProblems.length} validation problems`}
          >
            <CircleAlert className="size-4 shrink-0 text-destructive" />
          </span>
        )}
      </div>
      <p
        className="min-h-4 truncate px-3 pb-2 text-xs text-muted-foreground"
        title={summarizeNode(node)}
      >
        {summarizeNode(node)}
      </p>
      <div className="flex flex-wrap items-center gap-1 border-t px-3 py-1.5">
        <Badge variant="outline" className="whitespace-nowrap text-[10px]">
          {type}
        </Badge>
        {data.comment && (
          <span role="img" title={data.comment} aria-label="Node has a comment">
            <MessageSquare className="size-3.5 text-muted-foreground" />
          </span>
        )}
        {badge && (
          <Badge
            variant="secondary"
            className="whitespace-nowrap text-[10px]"
            data-testid="node-badge"
          >
            {badge}
          </Badge>
        )}
        {running && (
          <span className="ml-auto text-[10px] font-medium text-primary" data-testid="node-running">
            Running
          </span>
        )}
      </div>

      {nonErrorHandles.map((handle, index) => {
        const top = 36 + index * 20;
        return (
          <div key={handle.id}>
            <span
              className="pointer-events-none absolute right-3 translate-y-1 text-[10px] text-muted-foreground"
              style={{ top }}
            >
              {handle.kind === "route" ? handle.label : ""}
            </span>
            <Handle
              id={handle.id}
              type="source"
              position={Position.Right}
              style={{ top }}
              className="!size-2.5 !border-2 !border-background !bg-primary"
            />
          </div>
        );
      })}
      {errorHandle && (
        <div>
          <span
            className="pointer-events-none absolute right-3 text-[10px] text-destructive"
            style={{ top: 36 + nonErrorHandles.length * 20 }}
          >
            error
          </span>
          <Handle
            id={errorHandle.id}
            type="source"
            position={Position.Right}
            style={{ top: 36 + nonErrorHandles.length * 20 }}
            className="!size-2.5 !border-2 !border-background !bg-destructive"
          />
        </div>
      )}
    </div>
  );
}
