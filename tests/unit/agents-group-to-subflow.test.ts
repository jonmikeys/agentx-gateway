import { describe, expect, it } from "vitest";
import { createFlowNode, type FlowGraph, type FlowNode } from "@/lib/agents/graph";
import { convertGroupToSubflow } from "@/lib/agents/group-to-subflow";
import { validateGraph } from "@/lib/agents/validate";

function groupNode(id: string, x = 200, y = -32): FlowNode {
  return {
    id,
    type: "group",
    position: { x, y },
    width: 320,
    height: 200,
    zIndex: -1,
    data: { title: "Wrap", color: "grey", collapsed: false },
  } as FlowNode;
}

/** Start -> Reply -> End with the Reply wrapped in a visual group. */
function groupedReply(extra?: { note?: boolean; secondEnd?: boolean }): {
  graph: FlowGraph;
  groupId: string;
  replyId: string;
} {
  const start = createFlowNode("start", { x: 0, y: 0 });
  const reply = createFlowNode("reply", { x: 260, y: 0 }, { title: "Greeting" });
  const end = createFlowNode("end", { x: 520, y: 0 }, { title: "Done" });
  const groupId = "group_1";
  const nodes: FlowNode[] = [
    start,
    { ...reply, parentId: groupId, position: { x: 60, y: 32 } } as FlowNode,
    end,
    groupNode(groupId),
  ];
  const edges = [
    { id: "e_start_reply", source: start.id, target: reply.id, sourceHandle: "out" },
    { id: "e_reply_end", source: reply.id, target: end.id, sourceHandle: "out" },
  ];
  if (extra?.secondEnd) {
    const end2 = createFlowNode("end", { x: 520, y: 200 }, { title: "Done too" });
    nodes.push(end2);
    edges.push({ id: "e_reply_end2", source: reply.id, target: end2.id, sourceHandle: "out" });
  }
  if (extra?.note) {
    const note = createFlowNode("note", { x: 80, y: 120 }, { title: "Why", markdown: "Explain" });
    nodes.push({ ...note, parentId: groupId, position: { x: 80, y: 120 } } as FlowNode);
  }
  return { graph: { nodes, edges }, groupId, replyId: reply.id };
}

describe("convert group to subflow", () => {
  it("extracts the children and replaces the group with a Call Subflow node", () => {
    const { graph, groupId, replyId } = groupedReply();
    const result = convertGroupToSubflow(graph, groupId, { subflowName: "Wrapped reply" });
    if (!result.ok) throw new Error(result.error);

    const { subflow, parent, outputLabels, paramCount, callNodeId } = result.conversion;
    expect(paramCount).toBe(1);
    expect(outputLabels).toEqual(["done"]);

    // The subflow keeps the Reply node and gains an Input and an Output.
    expect(subflow.nodes.map((node) => node.type).sort()).toEqual([
      "reply",
      "subflow_input",
      "subflow_output",
    ]);
    const input = subflow.nodes.find((node) => node.type === "subflow_input");
    if (input?.type !== "subflow_input") throw new Error("missing input");
    expect(input.data.params).toEqual([{ name: "start", type: "string", required: true }]);
    const output = subflow.nodes.find((node) => node.type === "subflow_output");
    if (output?.type !== "subflow_output") throw new Error("missing output");
    expect(output.data.label).toBe("done");
    expect(subflow.nodes.some((node) => node.id === replyId)).toBe(true);
    expect(subflow.edges).toHaveLength(2);

    // The parent loses the group and its child, and gains the Call Subflow node.
    expect(parent.nodes.some((node) => node.type === "group")).toBe(false);
    expect(parent.nodes.some((node) => node.id === replyId)).toBe(false);
    const call = parent.nodes.find((node) => node.id === callNodeId);
    if (call?.type !== "call_subflow") throw new Error("missing call node");
    const startId = graph.nodes.find((node) => node.type === "start")?.id;
    expect(call.data.inputs).toEqual([{ name: "start", value: `{{nodes.${startId}.output}}` }]);
    expect(call.data.outputs).toEqual([{ label: "done", variable: "done" }]);
    const rewired = parent.edges.find((edge) => edge.source === callNodeId);
    expect(rewired?.sourceHandle).toBe("out:done");

    expect(validateGraph(subflow, { kind: "subflow" }).valid).toBe(true);
    expect(validateGraph(parent, { kind: "agent" }).valid).toBe(true);
  });

  it("refuses a group that contains a Start node", () => {
    const start = createFlowNode("start", { x: 0, y: 0 });
    const reply = createFlowNode("reply", { x: 260, y: 0 });
    const groupId = "group_1";
    const graph: FlowGraph = {
      nodes: [
        { ...start, parentId: groupId, position: { x: 60, y: 32 } } as FlowNode,
        { ...reply, parentId: groupId, position: { x: 320, y: 32 } } as FlowNode,
        groupNode(groupId),
      ],
      edges: [{ id: "e1", source: start.id, target: reply.id, sourceHandle: "out" }],
    };
    const result = convertGroupToSubflow(graph, groupId);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/Start node/);
  });

  it("refuses a group with no upstream connection", () => {
    const { graph, groupId } = groupedReply();
    const disconnected: FlowGraph = {
      ...graph,
      edges: graph.edges.filter(
        (edge) => edge.target !== graph.nodes.find((n) => n.parentId === groupId)?.id,
      ),
    };
    const result = convertGroupToSubflow(disconnected, groupId);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/upstream/);
  });

  it("gives each distinct exit its own output label", () => {
    const { graph, groupId } = groupedReply({ secondEnd: true });
    const result = convertGroupToSubflow(graph, groupId);
    if (!result.ok) throw new Error(result.error);
    expect(result.conversion.outputLabels).toEqual(["done", "done_too"]);
    expect(validateGraph(result.conversion.subflow, { kind: "subflow" }).valid).toBe(true);
    expect(validateGraph(result.conversion.parent, { kind: "agent" }).valid).toBe(true);
  });

  it("moves sticky notes with the children", () => {
    const { graph, groupId } = groupedReply({ note: true });
    const result = convertGroupToSubflow(graph, groupId);
    if (!result.ok) throw new Error(result.error);
    expect(result.conversion.subflow.nodes.some((node) => node.type === "note")).toBe(true);
    expect(result.conversion.parent.nodes.some((node) => node.type === "note")).toBe(false);
  });
});
