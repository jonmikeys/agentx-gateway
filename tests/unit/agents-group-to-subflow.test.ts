import { describe, expect, it } from "vitest";
import { createFlowNode, type FlowEdge, type FlowGraph, type FlowNode } from "@/lib/agents/graph";
import { convertGroupToSubflow } from "@/lib/agents/group-to-subflow";
import { validateGraph } from "@/lib/agents/validate";

const GROUP_ID = "group_1";

function groupNode(x = 200, y = -32): FlowNode {
  return {
    id: GROUP_ID,
    type: "group",
    position: { x, y },
    width: 320,
    height: 200,
    zIndex: -1,
    data: { title: "Wrap", color: "grey", collapsed: false },
  } as FlowNode;
}

function inGroup(node: FlowNode, x = 60, y = 32): FlowNode {
  return { ...node, parentId: GROUP_ID, position: { x, y } } as FlowNode;
}

function edge(source: string, target: string, sourceHandle = "out"): FlowEdge {
  return { id: `e_${source}_${target}_${sourceHandle}`, source, target, sourceHandle };
}

function replyText(graph: FlowGraph, id: string): string {
  const node = graph.nodes.find((candidate) => candidate.id === id);
  if (node?.type !== "reply") throw new Error(`no reply ${id}`);
  return node.data.template;
}

function withTemplate(graph: FlowGraph, id: string, template: string): FlowGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((node) =>
      node.id === id ? ({ ...node, data: { ...node.data, template } } as FlowNode) : node,
    ),
  };
}

/** Start -> [Greeting reply] -> End, with the Reply wrapped in a visual group. */
function groupedReply() {
  const start = createFlowNode("start", { x: 0, y: 0 });
  const reply = createFlowNode("reply", { x: 260, y: 0 }, { title: "Greeting", template: "Hello" });
  const end = createFlowNode("end", { x: 520, y: 0 }, { title: "Done" });
  const graph: FlowGraph = {
    nodes: [start, inGroup(reply), end, groupNode()],
    edges: [edge(start.id, reply.id), edge(reply.id, end.id)],
  };
  return { graph, start, reply, end };
}

describe("convert group to subflow", () => {
  it("extracts the children and replaces the group with a Call Subflow node", () => {
    const { graph, reply } = groupedReply();
    const result = convertGroupToSubflow(graph, GROUP_ID, { subflowName: "Wrapped reply" });
    if (!result.ok) throw new Error(result.error);
    const { subflow, parent, callNodeId, resultVariable } = result.conversion;

    expect(result.conversion.paramCount).toBe(0);
    expect(result.conversion.outputLabels).toEqual(["done"]);
    expect(subflow.nodes.map((node) => node.type).sort()).toEqual([
      "reply",
      "subflow_input",
      "subflow_output",
    ]);
    expect(subflow.nodes.some((node) => node.id === reply.id)).toBe(true);

    expect(parent.nodes.some((node) => node.type === "group" || node.id === reply.id)).toBe(false);
    const call = parent.nodes.find((node) => node.id === callNodeId);
    if (call?.type !== "call_subflow") throw new Error("missing call node");
    expect(call.data.outputs).toEqual([{ label: "done", variable: resultVariable }]);
    expect(parent.edges.find((e) => e.source === callNodeId)?.sourceHandle).toBe("out:done");

    expect(validateGraph(subflow, { kind: "subflow" }).valid).toBe(true);
    expect(validateGraph(parent, { kind: "agent" }).valid).toBe(true);
  });

  it("turns references to parent nodes and variables into params and rewrites them", () => {
    const base = groupedReply();
    const graph = withTemplate(
      base.graph,
      base.reply.id,
      `Hi {{vars.name}}, you said {{nodes.${base.start.id}.output}}`,
    );
    const result = convertGroupToSubflow(graph, GROUP_ID);
    if (!result.ok) throw new Error(result.error);
    const { subflow, parent, callNodeId } = result.conversion;

    const input = subflow.nodes.find((node) => node.type === "subflow_input");
    if (input?.type !== "subflow_input") throw new Error("missing input");
    const names = input.data.params.map((param) => param.name);
    expect(names).toHaveLength(2);
    expect(names).toContain("name");

    // The moved Reply only reads its own params now.
    const moved = replyText(subflow, base.reply.id);
    expect(moved).not.toContain("nodes.");
    for (const name of names) expect(moved).toContain(`{{vars.${name}}}`);

    // The caller maps each param from the original parent expression.
    const call = parent.nodes.find((node) => node.id === callNodeId);
    if (call?.type !== "call_subflow") throw new Error("missing call node");
    expect(call.data.inputs.map((entry) => entry.value).sort()).toEqual(
      [`{{nodes.${base.start.id}.output}}`, "{{vars.name}}"].sort(),
    );
    expect(validateGraph(subflow, { kind: "subflow" }).valid).toBe(true);
  });

  it("returns values the parent reads after the group and rewrites those references", () => {
    const { graph, reply, end } = groupedReply();
    const after = createFlowNode(
      "reply",
      { x: 520, y: 0 },
      {
        title: "Echo",
        template: `Earlier: {{nodes.${reply.id}.output}}`,
      },
    );
    const extended: FlowGraph = {
      nodes: [...graph.nodes, after],
      edges: [
        ...graph.edges.filter((e) => e.target !== end.id),
        edge(reply.id, after.id),
        edge(after.id, end.id),
      ],
    };

    const result = convertGroupToSubflow(extended, GROUP_ID);
    if (!result.ok) throw new Error(result.error);
    const { subflow, parent, resultVariable, exportedValues } = result.conversion;

    expect(exportedValues).toHaveLength(1);
    const output = subflow.nodes.find((node) => node.type === "subflow_output");
    if (output?.type !== "subflow_output") throw new Error("missing output");
    expect(output.data.values).toEqual([
      { name: exportedValues[0], value: `{{nodes.${reply.id}.output}}` },
    ]);
    // A single returned value lands directly in the result variable.
    expect(replyText(parent, after.id)).toBe(`Earlier: {{vars.${resultVariable}}}`);
    expect(validateGraph(parent, { kind: "agent" }).valid).toBe(true);
  });

  it("refuses a group with more than one entry node", () => {
    const start = createFlowNode("start", { x: 0, y: 0 });
    const router = createFlowNode("router", { x: 100, y: 0 });
    const left = createFlowNode("reply", { x: 260, y: 0 }, { template: "left" });
    const right = createFlowNode("reply", { x: 260, y: 100 }, { template: "right" });
    const end = createFlowNode("end", { x: 520, y: 0 });
    const graph: FlowGraph = {
      nodes: [start, router, inGroup(left), inGroup(right, 60, 140), end, groupNode()],
      edges: [
        edge(start.id, router.id),
        edge(router.id, left.id, "a"),
        edge(router.id, right.id, "b"),
        edge(left.id, end.id),
        edge(right.id, end.id),
      ],
    };
    const result = convertGroupToSubflow(graph, GROUP_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/one entry node/);
  });

  it("refuses a group that contains a Start node", () => {
    const start = createFlowNode("start", { x: 0, y: 0 });
    const reply = createFlowNode("reply", { x: 260, y: 0 });
    const graph: FlowGraph = {
      nodes: [inGroup(start), inGroup(reply, 320), groupNode()],
      edges: [edge(start.id, reply.id)],
    };
    const result = convertGroupToSubflow(graph, GROUP_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/Start node/);
  });

  it("refuses a group with no upstream connection", () => {
    const { graph, reply } = groupedReply();
    const disconnected = { ...graph, edges: graph.edges.filter((e) => e.target !== reply.id) };
    const result = convertGroupToSubflow(disconnected, GROUP_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/upstream/);
  });

  it("gives each distinct exit its own output label", () => {
    const { graph, reply } = groupedReply();
    const end2 = createFlowNode("end", { x: 520, y: 200 }, { title: "Done too" });
    const twoExits: FlowGraph = {
      nodes: [...graph.nodes, end2],
      edges: [...graph.edges, edge(reply.id, end2.id)],
    };
    const result = convertGroupToSubflow(twoExits, GROUP_ID);
    if (!result.ok) throw new Error(result.error);
    expect(result.conversion.outputLabels).toEqual(["done", "done_too"]);
    expect(validateGraph(result.conversion.subflow, { kind: "subflow" }).valid).toBe(true);
    expect(validateGraph(result.conversion.parent, { kind: "agent" }).valid).toBe(true);
  });

  it("moves sticky notes with the children", () => {
    const { graph } = groupedReply();
    const note = createFlowNode("note", { x: 0, y: 0 }, { title: "Why", markdown: "Explain" });
    const withNote = { ...graph, nodes: [...graph.nodes, inGroup(note, 80, 120)] };
    const result = convertGroupToSubflow(withNote, GROUP_ID);
    if (!result.ok) throw new Error(result.error);
    expect(result.conversion.subflow.nodes.some((node) => node.type === "note")).toBe(true);
    expect(result.conversion.parent.nodes.some((node) => node.type === "note")).toBe(false);
  });
});
