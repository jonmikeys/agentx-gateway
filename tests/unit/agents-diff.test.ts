import { describe, expect, it } from "vitest";
import { diffGraphs } from "@/lib/agents/diff";
import { createFlowNode, type FlowGraph } from "@/lib/agents/graph";

function baseGraph(): FlowGraph {
  const start = createFlowNode("start", { x: 0, y: 0 });
  const reply = createFlowNode("reply", { x: 260, y: 0 }, { title: "Greeting", template: "Hi" });
  const end = createFlowNode("end", { x: 520, y: 0 });
  return {
    nodes: [start, reply, end],
    edges: [
      { id: "e_start_reply", source: start.id, target: reply.id, sourceHandle: "out" },
      { id: "e_reply_end", source: reply.id, target: end.id, sourceHandle: "out" },
    ],
  };
}

describe("diffGraphs", () => {
  it("reports added, removed and changed nodes and edges", () => {
    const base = baseGraph();
    const reply = base.nodes.find((node) => node.type === "reply");
    const end = base.nodes.find((node) => node.type === "end");
    if (!reply || !end) throw new Error("fixture broken");

    const added = createFlowNode("note", { x: 0, y: 200 }, { title: "New note" });
    const draft: FlowGraph = {
      nodes: [
        ...base.nodes.filter((node) => node.type !== "end"),
        {
          ...reply,
          data: { ...reply.data, template: "Hello there" },
        } as (typeof base.nodes)[number],
        added,
      ],
      edges: [
        { id: "e_start_reply", source: base.nodes[0].id, target: reply.id, sourceHandle: "out" },
        { id: "e_new", source: reply.id, target: added.id, sourceHandle: "out" },
      ],
    };

    const diff = diffGraphs(base, draft);
    expect(diff.addedNodes.map((entry) => entry.id)).toEqual([added.id]);
    expect(diff.removedNodes.map((entry) => entry.id)).toEqual([end.id]);
    expect(diff.changedNodes.map((entry) => entry.id)).toEqual([reply.id]);
    expect(diff.addedEdges.map((entry) => entry.id)).toEqual(["e_new"]);
    expect(diff.removedEdges.map((entry) => entry.id)).toEqual(["e_reply_end"]);
    expect(diff.changedEdges).toEqual([]);
    expect(diff.nodes.get(reply.id)).toBe("changed");
    expect(diff.edges.get("e_new")).toBe("added");
    expect(diff.empty).toBe(false);
  });

  it("ignores pure position moves", () => {
    const base = baseGraph();
    const moved = {
      ...base,
      nodes: base.nodes.map((node) => ({
        ...node,
        position: { x: node.position.x + 40, y: node.position.y + 40 },
      })),
    } as FlowGraph;
    const diff = diffGraphs(base, moved);
    expect(diff.empty).toBe(true);
  });

  it("reports an empty diff for identical graphs", () => {
    const base = baseGraph();
    expect(diffGraphs(base, base).empty).toBe(true);
  });
});
