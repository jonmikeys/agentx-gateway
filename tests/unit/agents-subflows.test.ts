import { describe, expect, it } from "vitest";
import {
  createFlowNode,
  type FlowGraph,
  type FlowNode,
  type NodeType,
  nodeHandles,
  starterGraph,
} from "@/lib/agents/graph";
import {
  checkSubflowReferences,
  type PublishedFlowGraph,
  type PublishedFlowResolver,
} from "@/lib/agents/subflows";
import { validateGraph } from "@/lib/agents/validate";

function node(type: NodeType, overrides: Record<string, unknown> = {}): FlowNode {
  return createFlowNode(type, { x: 0, y: 0 }, overrides);
}

function graph(nodes: FlowNode[], edges: [string, string, string?][]): FlowGraph {
  return {
    nodes,
    edges: edges.map(([source, target, handle], index) => ({
      id: `e${index}`,
      source,
      target,
      sourceHandle: handle ?? "out",
    })),
  };
}

/** A published subflow graph with one required input and one output. */
function publishedSubflow(
  flowId: string,
  options: {
    version?: number;
    params?: { name: string; type?: string; required?: boolean }[];
    outputs?: string[];
    calls?: string[];
  } = {},
): PublishedFlowGraph {
  const input = node("subflow_input", {
    params: (options.params ?? [{ name: "topic", type: "string", required: true }]).map(
      (param) => ({
        name: param.name,
        type: param.type ?? "string",
        required: param.required ?? true,
      }),
    ),
  });
  const outputs = (options.outputs ?? ["result"]).map((label) => node("subflow_output", { label }));
  const nodes = [input, ...outputs];
  const edges: [string, string, string?][] = outputs.map((output) => [input.id, output.id]);
  for (const subflowId of options.calls ?? []) {
    const call = node("call_subflow", { subflowId, outputs: [{ label: "result", variable: "x" }] });
    nodes.push(call);
    edges.push([input.id, call.id], [call.id, outputs[0].id, "out:result"]);
  }
  return {
    flowId,
    version: options.version ?? 1,
    kind: "subflow",
    graph: graph(nodes, edges),
  };
}

function resolverOf(...entries: PublishedFlowGraph[]): PublishedFlowResolver {
  const map = new Map(entries.map((entry) => [entry.flowId, entry]));
  return (flowId) => map.get(flowId);
}

describe("subflow graph model", () => {
  it("starts a new subflow with a valid Input -> Output skeleton", () => {
    const starter = starterGraph("subflow");
    const result = validateGraph(starter, { kind: "subflow" });
    expect(result.valid).toBe(true);
    expect(starter.nodes.map((entry) => entry.type).sort()).toEqual([
      "subflow_input",
      "subflow_output",
    ]);
  });

  it("gives a Call Subflow one handle per output label plus an error handle", () => {
    const call = node("call_subflow", {
      subflowId: "agt_0123456789ab",
      outputs: [
        { label: "ok", variable: "ok_result" },
        { label: "empty", variable: "empty_result" },
      ],
    });
    const handles = nodeHandles(call);
    expect(handles.map((handle) => handle.id)).toEqual(["out:ok", "out:empty", "error"]);
  });
});

describe("subflow validation", () => {
  it("requires exactly one Subflow Input and at least one Subflow Output", () => {
    const outputOnly = node("subflow_output");
    const missing = validateGraph({ nodes: [outputOnly], edges: [] }, { kind: "subflow" });
    expect(missing.problems).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining("Subflow Input") }),
    );

    const input = node("subflow_input");
    const noOutput = validateGraph({ nodes: [input], edges: [] }, { kind: "subflow" });
    expect(noOutput.problems).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining("Subflow Output") }),
    );
  });

  it("rejects Start and End nodes inside a subflow", () => {
    const start = node("start");
    const input = node("subflow_input");
    const output = node("subflow_output");
    const result = validateGraph(graph([start, input, output], [[start.id, input.id]]), {
      kind: "subflow",
    });
    expect(result.problems).toContainEqual(
      expect.objectContaining({ nodeId: start.id, message: expect.stringContaining("Subflow") }),
    );
  });

  it("requires every path to reach a Subflow Output", () => {
    const input = node("subflow_input");
    const reply = node("reply");
    const result = validateGraph(graph([input, reply], [[input.id, reply.id]]), {
      kind: "subflow",
    });
    expect(result.problems).toContainEqual(
      expect.objectContaining({
        nodeId: reply.id,
        message: expect.stringContaining("Connect its output"),
      }),
    );
    expect(result.problems).toContainEqual(
      expect.objectContaining({ message: "Every path must reach a Subflow Output" }),
    );
  });

  it("requires a Call Subflow node to declare its output labels", () => {
    const input = node("subflow_input");
    const call = node("call_subflow", { subflowId: "agt_0123456789ab", outputs: [] });
    const output = node("subflow_output");
    const result = validateGraph(
      graph(
        [input, call, output],
        [
          [input.id, call.id],
          [call.id, output.id, "error"],
        ],
      ),
      { kind: "subflow" },
    );
    expect(result.problems).toContainEqual(
      expect.objectContaining({
        nodeId: call.id,
        message: expect.stringContaining("output label"),
      }),
    );
  });
});

describe("subflow reference checks", () => {
  it("covers every required input and matches output labels", () => {
    const target = publishedSubflow("agt_aaaaaaaaaaaa", {
      params: [
        { name: "topic", required: true },
        { name: "tone", required: false },
      ],
      outputs: ["ok", "empty"],
    });
    const call = node("call_subflow", {
      subflowId: "agt_aaaaaaaaaaaa",
      inputs: [{ name: "tone", value: "warm" }],
      outputs: [{ label: "ok", variable: "result" }],
    });
    const input = node("subflow_input");
    const output = node("subflow_output");
    const problems = checkSubflowReferences({
      flowId: "agt_rootrootroot",
      graph: graph(
        [input, call, output],
        [
          [input.id, call.id],
          [call.id, output.id, "out:ok"],
        ],
      ),
      resolver: resolverOf(target),
    });
    expect(problems).toContainEqual(
      expect.objectContaining({ message: 'Map the required input "topic"' }),
    );
    expect(problems).toContainEqual(
      expect.objectContaining({ message: 'Add an output for the subflow\'s "empty" branch' }),
    );
  });

  it("reports a target that is not published", () => {
    const call = node("call_subflow", {
      subflowId: "agt_missingmissing",
      outputs: [{ label: "result", variable: "result" }],
    });
    const input = node("subflow_input");
    const output = node("subflow_output");
    const problems = checkSubflowReferences({
      flowId: "agt_rootrootroot",
      graph: graph(
        [input, call, output],
        [
          [input.id, call.id],
          [call.id, output.id, "out:result"],
        ],
      ),
      resolver: resolverOf(),
    });
    expect(problems).toContainEqual(
      expect.objectContaining({
        nodeId: call.id,
        message: expect.stringContaining("not published"),
      }),
    );
  });

  it("blocks call cycles across published versions", () => {
    const a = publishedSubflow("agt_aaaaaaaaaaaa", { calls: ["agt_bbbbbbbbbbbb"] });
    const b = publishedSubflow("agt_bbbbbbbbbbbb", { calls: ["agt_aaaaaaaaaaaa"] });
    const root = node("call_subflow", {
      subflowId: "agt_aaaaaaaaaaaa",
      outputs: [{ label: "result", variable: "result" }],
    });
    const input = node("subflow_input");
    const output = node("subflow_output");
    const problems = checkSubflowReferences({
      flowId: "agt_rootrootroot",
      graph: graph(
        [input, root, output],
        [
          [input.id, root.id],
          [root.id, output.id, "out:result"],
        ],
      ),
      resolver: resolverOf(a, b),
    });
    expect(problems).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining("cycle") }),
    );
  });

  it("blocks self-calls and nesting deeper than five levels", () => {
    const chain = Array.from({ length: 6 }, (_, index) =>
      publishedSubflow(`agt_${String(index).repeat(12).slice(0, 12)}`, {
        calls:
          index === 5
            ? []
            : [
                `agt_${String(index + 1)
                  .repeat(12)
                  .slice(0, 12)}`,
              ],
      }),
    );
    const selfTarget = publishedSubflow("agt_selftarget11", { calls: ["agt_selftarget11"] });
    const selfCall = node("call_subflow", {
      subflowId: "agt_selftarget11",
      outputs: [{ label: "result", variable: "result" }],
    });
    const deepCall = node("call_subflow", {
      subflowId: chain[0].flowId,
      outputs: [{ label: "result", variable: "result" }],
    });
    const input = node("subflow_input");
    const output = node("subflow_output");
    const problems = checkSubflowReferences({
      flowId: "agt_rootrootroot",
      graph: graph(
        [input, selfCall, deepCall, output],
        [
          [input.id, selfCall.id],
          [selfCall.id, deepCall.id, "out:result"],
          [deepCall.id, output.id, "out:result"],
        ],
      ),
      resolver: resolverOf(selfTarget, ...chain),
    });
    expect(problems).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining("cycle") }),
    );
    expect(problems).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining("deeper than 5") }),
    );
  });
});
