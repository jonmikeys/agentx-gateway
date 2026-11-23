import { describe, expect, it } from "vitest";
import { createFlowNode, type FlowGraph, type FlowNode, type NodeType } from "@/lib/agents/graph";
import { problemsByNode, validateGraph } from "@/lib/agents/validate";

function node(type: NodeType, overrides: Record<string, unknown> = {}): FlowNode {
  return createFlowNode(type, { x: 0, y: 0 }, overrides);
}

function chain(...nodes: FlowNode[]): FlowGraph {
  return {
    nodes,
    edges: nodes.slice(0, -1).map((source, index) => ({
      id: `e${index}`,
      source: source.id,
      target: nodes[index + 1].id,
      sourceHandle: "out",
    })),
  };
}

describe("chatflow validation", () => {
  it("accepts a simple Start -> Reply -> End flow", () => {
    const start = node("start");
    const reply = node("reply");
    const end = node("end");
    const result = validateGraph(chain(start, reply, end));
    expect(result.valid).toBe(true);
    expect(result.problems).toEqual([]);
  });

  it("requires exactly one Start", () => {
    const reply = node("reply");
    expect(validateGraph({ nodes: [reply], edges: [] }).problems).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining("Start") }),
    );
    const result = validateGraph(chain(node("start"), reply, node("start")));
    expect(result.problems.some((problem) => problem.message.includes("one Start"))).toBe(true);
  });

  it("reports unconnected outputs and unreachable nodes per node", () => {
    const start = node("start");
    const llm = node("llm");
    const orphan = node("reply");
    const result = validateGraph({
      nodes: [start, llm, orphan],
      edges: [{ id: "e", source: start.id, target: llm.id, sourceHandle: "out" }],
    });
    expect(result.valid).toBe(false);
    expect(result.problems).toContainEqual(
      expect.objectContaining({
        nodeId: llm.id,
        message: expect.stringContaining("Connect its output"),
      }),
    );
    expect(result.problems).toContainEqual(
      expect.objectContaining({ nodeId: orphan.id, message: "Node is not reachable from Start" }),
    );
    const grouped = problemsByNode(result);
    expect(grouped.get(llm.id)?.length).toBeGreaterThan(0);
  });

  it("rejects cycles unless an edge is marked as a loop", () => {
    const start = node("start");
    const reply = node("reply");
    const graph: FlowGraph = {
      nodes: [start, reply],
      edges: [
        { id: "a", source: start.id, target: reply.id, sourceHandle: "out" },
        { id: "b", source: reply.id, target: start.id, sourceHandle: "out" },
      ],
    };
    expect(validateGraph(graph).problems).toContainEqual(
      expect.objectContaining({ nodeId: reply.id, message: expect.stringContaining("cycle") }),
    );
    const looped: FlowGraph = {
      ...graph,
      edges: graph.edges.map((edge) =>
        edge.id === "b" ? { ...edge, data: { loop: true } } : edge,
      ),
    };
    expect(validateGraph(looped).valid).toBe(true);
  });

  it("reports missing required fields on the offending node", () => {
    const start = node("start");
    const reply = node("reply", { template: "" });
    const end = node("end");
    const result = validateGraph(chain(start, reply, end));
    expect(result.valid).toBe(false);
    expect(result.problems).toContainEqual(
      expect.objectContaining({ nodeId: reply.id, message: expect.stringContaining("Reply text") }),
    );
  });

  it("requires a Router branch for every handle", () => {
    const start = node("start");
    const router = node("router", {
      rules: [
        { id: "yes", label: "Yes", operator: "contains", subject: "{{input.text}}", value: "yes" },
      ],
    });
    const reply = node("reply");
    const end = node("end");
    const graph: FlowGraph = {
      nodes: [start, router, reply, end],
      edges: [
        { id: "a", source: start.id, target: router.id, sourceHandle: "out" },
        { id: "b", source: router.id, target: reply.id, sourceHandle: "yes" },
        { id: "c", source: reply.id, target: end.id, sourceHandle: "out" },
      ],
    };
    const result = validateGraph(graph);
    expect(result.problems).toContainEqual(
      expect.objectContaining({ nodeId: router.id, message: expect.stringContaining("default") }),
    );
  });
});
