"use client";

import {
  addEdge,
  Background,
  BackgroundVariant,
  type Connection,
  Controls,
  MiniMap,
  ReactFlow,
} from "@xyflow/react";
import {
  applyEdgeChanges,
  applyNodeChanges,
  type EdgeChangeset,
  type NodeChangeset,
} from "@xyflow/system";
import "@xyflow/react/dist/style.css";
import {
  ArrowLeft,
  GitBranch,
  History,
  LayoutGrid,
  Redo2,
  Save,
  Settings2,
  SlidersHorizontal,
  Undo2,
  Upload,
  Variable,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { EditorUi } from "@/app/(crm)/chatflows/[id]/editor-context";
import {
  autoLayout,
  type EditorEdge,
  type EditorNode,
  toEditorEdges,
  toEditorNodes,
  toFlowGraph,
} from "@/app/(crm)/chatflows/[id]/flow-editor-utils";
import { FlowNodeCard } from "@/app/(crm)/chatflows/[id]/flow-node-card";
import { type McpOption, PropertiesPanel } from "@/app/(crm)/chatflows/[id]/properties-panel";
import { PublishDialog } from "@/app/(crm)/chatflows/[id]/publish-dialog";
import { SettingsPanel } from "@/app/(crm)/chatflows/[id]/settings-panel";
import { TestDrawer } from "@/app/(crm)/chatflows/[id]/test-drawer";
import { VersionDialog } from "@/app/(crm)/chatflows/[id]/version-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { adminFetch, errorMessage } from "@/lib/admin-client";
import {
  createFlowNode,
  type FlowNode,
  type NodeType,
  nodeCatalogFor,
  nodeHandles,
} from "@/lib/agents/graph";
import { variableSuggestions } from "@/lib/agents/templates";
import type { FlowDetail, SubflowOption } from "@/lib/agents/types";
import { problemsByNode, validateGraph } from "@/lib/agents/validate";
import { cn } from "@/lib/utils";

const nodeTypes = {
  start: FlowNodeCard,
  llm: FlowNodeCard,
  router: FlowNodeCard,
  set_variable: FlowNodeCard,
  webhook: FlowNodeCard,
  memory: FlowNodeCard,
  mcp_tool: FlowNodeCard,
  client_action: FlowNodeCard,
  reply: FlowNodeCard,
  end: FlowNodeCard,
  subflow_input: FlowNodeCard,
  subflow_output: FlowNodeCard,
  call_subflow: FlowNodeCard,
};

const nodeIcon = (type: NodeType) => {
  switch (type) {
    case "router":
      return GitBranch;
    case "set_variable":
    case "memory":
      return Variable;
    default:
      return SlidersHorizontal;
  }
};

interface ChatflowEditorProps {
  initialFlow: FlowDetail;
  routes: string[];
  mcpServers: { id: string; name: string; slug: string; enabled: boolean }[];
  mcpTools: McpOption[];
  media: { id: string; name: string; kind: string; tags: string[] }[];
  mediaTags: string[];
  cameras: { id: string; name: string; enabled: boolean }[];
  subflows: SubflowOption[];
}

function variableNames(nodes: EditorNode[]): string[] {
  const names = new Set<string>();
  for (const node of nodes) {
    const data = node.data as Record<string, unknown>;
    if (typeof data.outputVariable === "string") names.add(data.outputVariable);
    if (Array.isArray(data.assignments)) {
      for (const assignment of data.assignments as { key?: unknown }[]) {
        if (typeof assignment.key === "string") names.add(assignment.key);
      }
    }
    if (Array.isArray(data.outputs)) {
      for (const output of data.outputs as { variable?: unknown }[]) {
        if (typeof output.variable === "string") names.add(output.variable);
      }
    }
  }
  return [...names];
}

/** Visual chatflow editor: palette, canvas, inspector, publish/version dialogs and the test drawer. */
export function ChatflowEditor({
  initialFlow,
  routes,
  mcpServers,
  mcpTools,
  media,
  mediaTags,
  cameras,
  subflows,
}: ChatflowEditorProps) {
  const router = useRouter();
  const [flow, setFlow] = useState(initialFlow);
  const [view, setView] = useState<"editor" | "settings">("editor");
  const [nodes, setNodes] = useState<EditorNode[]>(() => toEditorNodes(initialFlow.draft));
  const [edges, setEdges] = useState<EditorEdge[]>(() => toEditorEdges(initialFlow.draft));
  const [publishOpen, setPublishOpen] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [runningNodeId, setRunningNodeId] = useState<string | undefined>();
  const [traceNodeId, setTraceNodeId] = useState<string | undefined>();
  const [mobilePanel, setMobilePanel] = useState<"palette" | "properties" | undefined>();
  const [saveState, setSaveState] = useState<"saved" | "unsaved" | "saving" | "error">("saved");
  const [savedAt, setSavedAt] = useState(initialFlow.draft_updated_at);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const past = useRef<{ nodes: EditorNode[]; edges: EditorEdge[] }[]>([]);
  const future = useRef<{ nodes: EditorNode[]; edges: EditorEdge[] }[]>([]);
  const clipboard = useRef<{ nodes: EditorNode[]; edges: EditorEdge[] } | null>(null);
  const savedJson = useRef(JSON.stringify(toFlowGraph(nodes, edges)));
  const savedStamp = useRef(initialFlow.draft_updated_at);

  const graph = useMemo(() => toFlowGraph(nodes, edges), [nodes, edges]);
  const graphJson = useMemo(() => JSON.stringify(graph), [graph]);
  const validation = useMemo(() => validateGraph(graph), [graph]);
  const problems = useMemo(() => problemsByNode(validation), [validation]);
  const knownNodeIds = useMemo(() => nodes.map((node) => node.id), [nodes]);
  const variables = useMemo(
    () =>
      variableSuggestions(
        nodes.map((node) => ({ id: node.id, title: node.data.title })),
        variableNames(nodes),
      ),
    [nodes],
  );
  const selected = nodes.find((node) => node.selected);

  // "Update available" for Call Subflow nodes whose target gained a published version since the
  // version this flow currently pins.
  const nodeBadges = useMemo(() => {
    const badges = new Map<string, string>();
    for (const node of nodes) {
      if (node.type !== "call_subflow") continue;
      const subflowId = (node.data as { subflowId?: string | null }).subflowId;
      if (!subflowId) continue;
      const latest = subflows.find((entry) => entry.id === subflowId)?.version;
      const pinned = flow.pinned_subflows[subflowId];
      if (latest !== undefined && pinned !== undefined && latest > pinned) {
        badges.set(node.id, `Update v${pinned} → v${latest}`);
      }
    }
    return badges;
  }, [nodes, subflows, flow.pinned_subflows]);

  function pushHistory() {
    past.current.push({ nodes, edges });
    if (past.current.length > 60) past.current.shift();
    future.current = [];
  }

  function undo() {
    const previous = past.current.pop();
    if (!previous) return;
    future.current.push({ nodes, edges });
    setNodes(previous.nodes);
    setEdges(previous.edges);
  }

  function redo() {
    const next = future.current.pop();
    if (!next) return;
    past.current.push({ nodes, edges });
    setNodes(next.nodes);
    setEdges(next.edges);
  }

  function updateNodeData(data: EditorNode["data"]) {
    if (!selected) return;
    setNodes((current) =>
      current.map((node) => (node.id === selected.id ? { ...node, data } : node)),
    );
  }

  function addNode(type: NodeType) {
    const anchor = selected;
    const position = anchor
      ? { x: anchor.position.x + 320, y: anchor.position.y }
      : { x: 80 + (nodes.length % 3) * 60, y: 80 + (nodes.length % 3) * 60 };
    const created = createFlowNode(type, position) as FlowNode;
    const editorNode = toEditorNodes({ nodes: [created], edges: [] })[0];
    pushHistory();
    let nextEdges = edges;
    if (anchor && anchor.type !== "end" && anchor.type !== "subflow_output" && type !== "start") {
      const anchorFlow = {
        id: anchor.id,
        type: anchor.type,
        position: anchor.position,
        data: anchor.data,
      } as FlowNode;
      const handle = nodeHandles(anchorFlow).find((entry) => entry.kind !== "error")?.id;
      const alreadyConnected = edges.some(
        (edge) => edge.source === anchor.id && (edge.sourceHandle ?? "out") === handle,
      );
      if (handle && !alreadyConnected) {
        nextEdges = [
          ...edges,
          {
            id: `e_${anchor.id}_${created.id}`,
            source: anchor.id,
            target: created.id,
            sourceHandle: handle,
            type: "smoothstep",
          },
        ];
      }
    }
    setNodes([...nodes, editorNode]);
    setEdges(nextEdges);
    setMobilePanel(undefined);
  }

  function onNodesChange(changes: NodeChangeset<EditorNode>) {
    setNodes((current) => applyNodeChanges(current, changes));
  }

  function onEdgesChange(changes: EdgeChangeset<EditorEdge>) {
    setEdges((current) => applyEdgeChanges(current, changes));
  }

  function onConnect(connection: Connection) {
    pushHistory();
    setEdges((current) =>
      addEdge(
        {
          ...connection,
          id: `e_${connection.source}_${connection.target}_${Date.now().toString(36)}`,
          type: "smoothstep",
        },
        current,
      ),
    );
  }

  function runLayout() {
    pushHistory();
    setNodes((current) => autoLayout(current, edges));
  }

  function copySelection() {
    const selectedNodes = nodes.filter((node) => node.selected);
    if (selectedNodes.length === 0) return;
    const ids = new Set(selectedNodes.map((node) => node.id));
    clipboard.current = {
      nodes: selectedNodes,
      edges: edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target)),
    };
  }

  function pasteSelection() {
    const content = clipboard.current;
    if (!content) return;
    const mapping = new Map<string, string>();
    const stamp = Date.now().toString(36);
    const clones = content.nodes.map((node, index) => {
      const id = `${node.type}_${stamp}_${index}`;
      mapping.set(node.id, id);
      return {
        ...node,
        id,
        selected: true,
        position: { x: node.position.x + 48, y: node.position.y + 48 },
      } as EditorNode;
    });
    const clonedEdges = content.edges.map((edge, index) => ({
      ...edge,
      id: `e_${stamp}_${index}`,
      source: mapping.get(edge.source) as string,
      target: mapping.get(edge.target) as string,
    }));
    pushHistory();
    setNodes([...nodes.map((node) => ({ ...node, selected: false })), ...clones]);
    setEdges([...edges, ...clonedEdges]);
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const typing =
        target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable;
      if (typing) return;
      const modifier = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (modifier && key === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      if (modifier && key === "y") {
        event.preventDefault();
        redo();
        return;
      }
      if (modifier && key === "c") {
        copySelection();
        return;
      }
      if (modifier && key === "v") {
        pasteSelection();
        return;
      }
      if (
        (event.key === "Delete" || event.key === "Backspace") &&
        nodes.some((node) => node.selected)
      ) {
        if (!canvasRef.current?.contains(document.activeElement)) return;
        pushHistory();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  // Autosave: last save wins; the server warns when another save landed since this copy opened.
  useEffect(() => {
    if (graphJson === savedJson.current) {
      setSaveState("saved");
      return;
    }
    setSaveState("unsaved");
    const timer = setTimeout(async () => {
      setSaveState("saving");
      try {
        const result = await adminFetch<{
          draft_updated_at: string;
          conflict: boolean;
        }>(`flows/${flow.id}/draft`, {
          method: "PUT",
          body: { graph, base_draft_updated_at: savedStamp.current },
        });
        savedStamp.current = result.draft_updated_at;
        savedJson.current = graphJson;
        setSavedAt(result.draft_updated_at);
        setSaveState("saved");
        if (result.conflict) {
          toast.warning(
            "Another save landed since you opened this chatflow. Your latest save won.",
          );
        }
      } catch (error) {
        setSaveState("error");
        toast.error(errorMessage(error));
      }
    }, 900);
    return () => clearTimeout(timer);
  }, [graphJson, graph, flow.id]);

  function applyRestored(next: FlowDetail) {
    setFlow(next);
    setNodes(toEditorNodes(next.draft));
    setEdges(toEditorEdges(next.draft));
    savedJson.current = JSON.stringify(
      toFlowGraph(toEditorNodes(next.draft), toEditorEdges(next.draft)),
    );
    savedStamp.current = next.draft_updated_at;
    setSaveState("saved");
    router.refresh();
  }

  const palette = (
    <div className="space-y-3">
      {(["Flow", "AI", "Actions", "Data"] as const).map((group) => (
        <div key={group} className="space-y-1">
          <p className="px-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
            {group}
          </p>
          {nodeCatalogFor(flow.kind)
            .filter((entry) => entry.group === group)
            .map((entry) => {
              const Icon = nodeIcon(entry.type);
              return (
                <button
                  key={entry.type}
                  type="button"
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent focus:bg-accent focus:outline-none"
                  onClick={() => addNode(entry.type)}
                  title={entry.description}
                  aria-label={`Add ${entry.label} node`}
                >
                  <Icon className="size-3.5 text-muted-foreground" />
                  <span className="font-medium">{entry.label}</span>
                </button>
              );
            })}
        </div>
      ))}
    </div>
  );

  const inspector = (
    <PropertiesPanel
      data={selected?.data}
      nodeType={selected?.type}
      routes={routes}
      mcpServers={mcpServers}
      mcpTools={mcpTools}
      media={media}
      cameras={cameras}
      allowedMediaTags={flow.settings.allowed_media_tags ?? []}
      allowedCameraIds={flow.settings.allowed_cameras ?? []}
      subflows={subflows}
      variables={variables}
      knownNodeIds={knownNodeIds}
      onChange={updateNodeData}
    />
  );

  const saveLabel =
    saveState === "saving"
      ? "Saving…"
      : saveState === "unsaved"
        ? "Unsaved changes"
        : saveState === "error"
          ? "Save failed"
          : "Saved";

  return (
    <EditorUi.Provider
      value={{
        problems,
        runningNodeId,
        traceNodeId,
        nodeBadges,
        onRename: (nodeId, title) =>
          setNodes((current) =>
            current.map((node) =>
              node.id === nodeId ? { ...node, data: { ...node.data, title } } : node,
            ),
          ),
      }}
    >
      <div className="flex h-[calc(100dvh-8.5rem)] min-h-[520px] min-w-0 flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild variant="ghost" size="sm" className="-ml-2">
            <Link href="/chatflows">
              <ArrowLeft />
              Chatflows
            </Link>
          </Button>
          <h1 className="min-w-0 truncate text-lg font-semibold tracking-tight">{flow.name}</h1>
          <Badge variant="outline">{flow.kind === "subflow" ? "Subflow" : "Agent"}</Badge>
          <Badge variant="secondary">
            {flow.published_version === null ? "Draft" : `v${flow.published_version}`}
          </Badge>
          <span
            data-testid="save-indicator"
            className={cn(
              "flex items-center gap-1 text-xs",
              saveState === "error" ? "text-destructive" : "text-muted-foreground",
            )}
          >
            <Save className="size-3" />
            {saveLabel}
            {saveState === "saved" && (
              <span className="hidden sm:inline">· {savedAt.slice(11, 16)} UTC</span>
            )}
          </span>
          <div className="ml-auto flex flex-wrap items-center gap-1">
            <Button variant="outline" size="icon-sm" aria-label="Undo" onClick={undo}>
              <Undo2 />
            </Button>
            <Button variant="outline" size="icon-sm" aria-label="Redo" onClick={redo}>
              <Redo2 />
            </Button>
            <Button variant="outline" size="icon-sm" aria-label="Auto-layout" onClick={runLayout}>
              <LayoutGrid />
            </Button>
            <Button
              variant={view === "settings" ? "secondary" : "outline"}
              size="sm"
              aria-pressed={view === "settings"}
              onClick={() => setView(view === "settings" ? "editor" : "settings")}
            >
              <Settings2 />
              Settings
            </Button>
            <Button variant="outline" size="sm" onClick={() => setVersionsOpen(true)}>
              <History />
              Versions
            </Button>
            <Button size="sm" onClick={() => setPublishOpen(true)}>
              <Upload />
              Publish
            </Button>
          </div>
        </div>

        {view === "settings" ? (
          <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border">
            <SettingsPanel
              flow={flow}
              routes={routes}
              mediaTags={mediaTags}
              cameras={cameras}
              onSaved={(next) => setFlow(next)}
            />
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 gap-3">
            <aside className="hidden w-44 shrink-0 overflow-y-auto rounded-lg border p-2 md:block">
              {palette}
            </aside>
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <div className="flex items-center gap-2 md:hidden">
                <Button variant="outline" size="sm" onClick={() => setMobilePanel("palette")}>
                  Add node
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setMobilePanel("properties")}
                  disabled={!selected}
                >
                  Properties
                </Button>
              </div>
              <div
                ref={canvasRef}
                className="relative min-h-[320px] flex-1 overflow-hidden rounded-lg border"
              >
                <ReactFlow
                  nodes={nodes}
                  edges={edges}
                  nodeTypes={nodeTypes}
                  onNodesChange={onNodesChange}
                  onEdgesChange={onEdgesChange}
                  onConnect={onConnect}
                  onNodeDragStart={pushHistory}
                  fitView
                  fitViewOptions={{ padding: 0.2 }}
                  minZoom={0.3}
                  maxZoom={1.6}
                  snapToGrid
                  snapGrid={[16, 16]}
                  selectionOnDrag
                  multiSelectionKeyCode="Shift"
                  deleteKeyCode={["Delete", "Backspace"]}
                  className="bg-muted/20"
                >
                  <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
                  <Controls position="top-left" showInteractive={false} />
                  {/* Top-right keeps the minimap clear of the graph; hidden while the drawer shrinks the canvas. */}
                  {!drawerOpen && (
                    <MiniMap position="top-right" pannable zoomable className="!bg-card" />
                  )}
                </ReactFlow>
              </div>
              {!validation.valid && (
                <div className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs">
                  <p className="font-medium text-destructive">
                    {validation.problems.length} problem
                    {validation.problems.length === 1 ? "" : "s"} before publishing
                  </p>
                  <ul className="mt-1 max-h-20 space-y-0.5 overflow-y-auto">
                    {validation.problems.slice(0, 8).map((problem) => (
                      <li
                        key={`${problem.nodeId ?? "flow"}-${problem.message}`}
                        className="break-words"
                      >
                        {problem.nodeTitle ? `${problem.nodeTitle}: ` : ""}
                        {problem.message}
                      </li>
                    ))}
                    {validation.problems.length > 8 && (
                      <li className="text-muted-foreground">
                        …and {validation.problems.length - 8} more. Publish shows the full list.
                      </li>
                    )}
                  </ul>
                </div>
              )}
              <TestDrawer
                flowId={flow.id}
                nodes={nodes.map((node) => ({
                  id: node.id,
                  title: node.data.title,
                  type: node.type ?? "",
                }))}
                open={drawerOpen}
                onOpenChange={setDrawerOpen}
                onRunningNode={setRunningNodeId}
                onTraceNode={setTraceNodeId}
              />
            </div>
            <aside className="hidden w-80 shrink-0 overflow-y-auto rounded-lg border lg:block">
              {inspector}
            </aside>
          </div>
        )}

        <Sheet
          open={mobilePanel !== undefined}
          onOpenChange={(open) => !open && setMobilePanel(undefined)}
        >
          <SheetContent side="right" className="w-[min(92vw,26rem)] overflow-y-auto">
            <SheetHeader>
              <SheetTitle>
                {mobilePanel === "palette" ? "Add a node" : "Node properties"}
              </SheetTitle>
            </SheetHeader>
            <div className="px-4 pb-4">{mobilePanel === "palette" ? palette : inspector}</div>
          </SheetContent>
        </Sheet>

        <PublishDialog
          open={publishOpen}
          flowId={flow.id}
          onOpenChange={setPublishOpen}
          onPublished={(next) =>
            setFlow((current) => ({
              ...current,
              published_version: next.published_version,
              version_count: next.version_count,
              updated_at: next.updated_at,
            }))
          }
        />
        <VersionDialog
          open={versionsOpen}
          flowId={flow.id}
          onOpenChange={setVersionsOpen}
          onRestored={applyRestored}
        />
      </div>
    </EditorUi.Provider>
  );
}
