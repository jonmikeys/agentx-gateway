import { beforeEach, describe, expect, it } from "vitest";
import { createFlowNode, type FlowGraph, type FlowNode, type NodeType } from "@/lib/agents/graph";
import { clearCompiledGraphCache } from "@/server/agents/compiler";
import { createInMemoryMemoryStore } from "@/server/agents/memory";
import { runAgent } from "@/server/agents/runtime";

function node(type: NodeType, overrides: Record<string, unknown> = {}): FlowNode {
  return createFlowNode(type, { x: 0, y: 0 }, overrides);
}

function flow(nodes: FlowNode[], edges: [string, string, string?][]): FlowGraph {
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

const sessionId = "11111111-1111-4111-8111-111111111111";

function run(graph: FlowGraph, flowId: string, deps = {}) {
  const events: string[] = [];
  return runAgent({
    flowId,
    version: 1,
    graph,
    sessionId,
    messages: [{ role: "user", content: "Ada" }],
    inputText: "Ada",
    route: undefined,
    signal: new AbortController().signal,
    deps: { memory: createInMemoryMemoryStore(), ...deps },
    onEvent: (event) => events.push(event.type),
  }).then((result) => ({ result, events }));
}

describe("compiler and runtime", () => {
  beforeEach(() => clearCompiledGraphCache());

  it("runs a graph through LangGraph and records every node", async () => {
    const start = node("start");
    const setter = node("set_variable", {
      assignments: [{ key: "greeting", value: "Hi {{input.text}}" }],
    });
    const reply = node("reply", { template: "{{vars.greeting}}!" });
    const end = node("end");
    const graph = flow(
      [start, setter, reply, end],
      [
        [start.id, setter.id],
        [setter.id, reply.id],
        [reply.id, end.id],
      ],
    );
    const { result, events } = await run(graph, "agt_compiler_1");
    expect(result.status).toBe("ok");
    expect(result.reply).toBe("Hi Ada!");
    expect(result.trace.steps.map((step) => step.node_type)).toEqual([
      "start",
      "set_variable",
      "reply",
      "end",
    ]);
    expect(result.trace.steps.every((step) => step.status === "ok")).toBe(true);
    expect(events).toContain("node_start");
    expect(events).toContain("text");
    expect(events).toContain("done");
  });

  it("runs a graph whose node ids collide with LangGraph state channels", async () => {
    const start = { ...node("start"), id: "start" };
    const setter = {
      ...node("set_variable", { assignments: [{ key: "x", value: "1" }] }),
      id: "vars",
    };
    const reply = { ...node("reply", { template: "ok {{vars.x}}" }), id: "memory" };
    const end = { ...node("end"), id: "end" };
    const graph = flow(
      [start, setter, reply, end],
      [
        [start.id, setter.id],
        [setter.id, reply.id],
        [reply.id, end.id],
      ],
    );
    const { result } = await run(graph, "agt_compiler_6");
    expect(result.status).toBe("ok");
    expect(result.reply).toBe("ok 1");
  });

  it("follows the error handle when a fallible node fails", async () => {
    const start = node("start");
    const tool = node("mcp_tool", {
      serverId: "22222222-2222-4222-8222-222222222222",
      toolName: "fail",
      args: [],
      outputVariable: "tool",
    });
    const recovery = node("reply", { template: "Sorry, the tool failed." });
    const end = node("end");
    const graph = flow(
      [start, tool, recovery, end],
      [
        [start.id, tool.id],
        [tool.id, recovery.id, "error"],
        [recovery.id, end.id],
      ],
    );
    const { result } = await run(graph, "agt_compiler_2", {
      mcpCall: async () => {
        throw new Error("boom");
      },
    });
    expect(result.status).toBe("ok");
    expect(result.reply).toBe("Sorry, the tool failed.");
    const failed = result.trace.steps.find((step) => step.node_type === "mcp_tool");
    expect(failed?.status).toBe("error");
    expect(failed?.error).toContain("mcp_call_failed");
  });

  it("marks the run failed when an error has no error branch", async () => {
    const start = node("start");
    const tool = node("mcp_tool", {
      serverId: "22222222-2222-4222-8222-222222222222",
      toolName: "fail",
      args: [],
      outputVariable: "tool",
    });
    const end = node("end");
    const graph = flow(
      [start, tool, end],
      [
        [start.id, tool.id],
        [tool.id, end.id],
      ],
    );
    const { result } = await run(graph, "agt_compiler_3", {
      mcpCall: async () => {
        throw new Error("boom");
      },
    });
    expect(result.status).toBe("error");
    expect(result.trace.failed_node_id).toBe(tool.id);
    expect(result.reply).toBe("");
  });

  it("persists memory across runs of the same session", async () => {
    const store = createInMemoryMemoryStore();
    const start = node("start");
    const setter = node("memory", {
      operation: "set",
      key: "name",
      value: "{{input.text}}",
      outputVariable: "stored",
    });
    const end = node("end");
    const write = flow(
      [start, setter, end],
      [
        [start.id, setter.id],
        [setter.id, end.id],
      ],
    );
    await run(write, "agt_compiler_4", { memory: store });

    const getter = node("memory", { operation: "get", key: "name", outputVariable: "recalled" });
    const reply = node("reply", { template: "Name: {{vars.recalled}}" });
    const read = flow(
      [start, getter, reply, end],
      [
        [start.id, getter.id],
        [getter.id, reply.id],
        [reply.id, end.id],
      ],
    );
    const { result } = await run(read, "agt_compiler_5", { memory: store });
    expect(result.reply).toBe("Name: Ada");
  });
});
