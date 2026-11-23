import { beforeEach, describe, expect, it } from "vitest";
import { createFlowNode, type FlowGraph, type FlowNode } from "@/lib/agents/graph";
import { validateGraph } from "@/lib/agents/validate";
import { clearCompiledGraphCache } from "@/server/agents/compiler";
import { createInMemoryMemoryStore } from "@/server/agents/memory";
import { runAgent } from "@/server/agents/runtime";

function noteNode(id: string, overrides: Record<string, unknown> = {}): FlowNode {
  return {
    id,
    type: "note",
    position: { x: 0, y: 0 },
    width: 240,
    height: 160,
    data: { title: "Sticky", markdown: "**Hi**", color: "yellow", ...overrides },
  } as FlowNode;
}

function groupNode(id: string): FlowNode {
  return {
    id,
    type: "group",
    position: { x: -32, y: -32 },
    width: 400,
    height: 240,
    zIndex: -1,
    data: { title: "Group", color: "grey", collapsed: false },
  } as FlowNode;
}

function runtimeGraph(): FlowGraph {
  const start = createFlowNode("start", { x: 0, y: 0 });
  const reply = createFlowNode("reply", { x: 260, y: 0 }, { template: "hello" });
  const end = createFlowNode("end", { x: 520, y: 0 });
  return {
    nodes: [start, reply, end],
    edges: [
      { id: "e1", source: start.id, target: reply.id, sourceHandle: "out" },
      { id: "e2", source: reply.id, target: end.id, sourceHandle: "out" },
    ],
  };
}

describe("canvas-only nodes", () => {
  beforeEach(() => clearCompiledGraphCache());

  it("validateGraph ignores notes and groups", () => {
    const graph = runtimeGraph();
    const note = noteNode("note_1");
    const group = groupNode("group_1");
    const grouped = {
      ...graph,
      nodes: [
        ...graph.nodes,
        note,
        { ...group, parentId: undefined },
        { ...note, id: "note_2", parentId: "group_1" } as FlowNode,
      ],
    };
    const result = validateGraph(grouped as FlowGraph);
    expect(result.problems).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("validateGraph still reports a genuinely broken flow with notes present", () => {
    const reply = createFlowNode("reply", { x: 0, y: 0 });
    const graph = {
      nodes: [reply, noteNode("note_1")],
      edges: [],
    };
    const result = validateGraph(graph as FlowGraph);
    expect(result.valid).toBe(false);
    expect(result.problems.some((problem) => problem.nodeId === "note_1")).toBe(false);
  });

  it("the compiler and runtime skip notes and groups", async () => {
    const graph = runtimeGraph();
    const group = groupNode("group_1");
    const note = noteNode("note_1");
    const decorated = {
      ...graph,
      nodes: [group, ...graph.nodes, { ...note, parentId: "group_1" } as FlowNode],
    };
    const result = await runAgent({
      flowId: "agt_canvas_1",
      version: 1,
      graph: decorated as FlowGraph,
      sessionId: "11111111-1111-4111-8111-111111111111",
      messages: [{ role: "user", content: "hi" }],
      inputText: "hi",
      route: undefined,
      signal: new AbortController().signal,
      deps: { memory: createInMemoryMemoryStore() },
    });
    expect(result.status).toBe("ok");
    expect(result.reply).toBe("hello");
    expect(result.trace.steps.map((step) => step.node_type)).toEqual(["start", "reply", "end"]);
  });
});
