import { MemorySaver } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";
import {
  type ClientToolDefinition,
  clientActionProblem,
  renderClientActionArgs,
  restrictClientTools,
  selectClientTools,
} from "@/lib/agents/client-tools";
import { createFlowNode, type FlowGraph, type FlowNode, type NodeType } from "@/lib/agents/graph";
import { createInMemoryMemoryStore } from "@/server/agents/memory";
import { type AgentRunContext, type AgentState, executeNode } from "@/server/agents/nodes";
import { runAgent } from "@/server/agents/runtime";
import type { ResolvedRoute } from "@/server/services/routes";

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

const showImage: ClientToolDefinition = {
  type: "function",
  function: {
    name: "show_image",
    description: "Show an image.",
    parameters: {
      type: "object",
      properties: { media_id: { type: "string", enum: ["med_a", "med_b"] } },
      required: ["media_id"],
    },
  },
};

const showCamera: ClientToolDefinition = {
  type: "function",
  function: {
    name: "show_camera",
    parameters: {
      type: "object",
      properties: { camera_id: { type: "string", enum: ["cam_a", "cam_b"] } },
      required: ["camera_id"],
    },
  },
};

const route: ResolvedRoute = {
  id: "route-1",
  slug: "client-route",
  steps: [
    {
      provider: {
        id: "provider-1",
        name: "Mock",
        baseUrl: "http://mock.local",
        enabled: true,
        capabilities: { streaming: true, tools: true, responses_api: false },
        apiKey: null,
        extraHeaders: {},
      },
      upstreamModel: "mock-model",
      timeoutMs: 5000,
    },
  ],
  mcpTools: [],
  builtinTools: [],
};

function completion(message: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-mock",
      object: "chat.completion",
      choices: [{ index: 0, message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }],
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function toolCallingFetch(counter: { calls: number }): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    counter.calls += 1;
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      messages?: { role?: string }[];
    };
    const last = body.messages?.at(-1);
    if (last?.role === "tool") {
      return completion({ role: "assistant", content: "Done: image shown." });
    }
    return completion({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "show_image", arguments: '{"media_id":"med_a"}' },
        },
      ],
    });
  }) as typeof fetch;
}

function sessionMessages(text: string): unknown[] {
  return [{ role: "user", content: text }];
}

function resumedMessages(text: string, toolResult = '{"ok":true}'): unknown[] {
  return [
    { role: "user", content: text },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "show_image", arguments: '{"media_id":"med_a"}' },
        },
      ],
    },
    { role: "tool", tool_call_id: "call_1", content: toolResult },
  ];
}

describe("client tool selection and restrictions", () => {
  it("offers none, all or the named subset", () => {
    const tools = [showImage, showCamera];
    expect(selectClientTools(tools, { mode: "none", names: [] })).toEqual([]);
    expect(selectClientTools(tools, { mode: "all", names: [] })).toEqual(tools);
    expect(selectClientTools(tools, { mode: "subset", names: ["show_camera"] })).toEqual([
      showCamera,
    ]);
  });

  it("narrows media and camera enums to the allowed sets without mutating the input", () => {
    const restricted = restrictClientTools([showImage, showCamera], {
      mediaIds: ["med_a"],
      cameraIds: ["cam_b"],
    });
    const mediaEnum = (
      restricted[0].function.parameters as { properties: { media_id: { enum: string[] } } }
    ).properties.media_id.enum;
    const cameraEnum = (
      restricted[1].function.parameters as { properties: { camera_id: { enum: string[] } } }
    ).properties.camera_id.enum;
    expect(mediaEnum).toEqual(["med_a"]);
    expect(cameraEnum).toEqual(["cam_b"]);
    expect(
      (showImage.function.parameters as { properties: { media_id: { enum: string[] } } }).properties
        .media_id.enum,
    ).toEqual(["med_a", "med_b"]);
    expect(restrictClientTools([showImage], { mediaIds: null, cameraIds: null })).toEqual([
      showImage,
    ]);
  });

  it("rejects Client Actions outside the allowed media and cameras", () => {
    expect(
      clientActionProblem(
        "show_image",
        { media_id: "med_c" },
        {
          mediaIds: ["med_a"],
          cameraIds: null,
        },
      ),
    ).toContain("outside");
    expect(
      clientActionProblem(
        "show_camera",
        { camera_id: "cam_a" },
        {
          mediaIds: null,
          cameraIds: ["cam_b"],
        },
      ),
    ).toContain("not in");
    expect(
      clientActionProblem(
        "show_image",
        { media_id: "med_a" },
        {
          mediaIds: ["med_a"],
          cameraIds: null,
        },
      ),
    ).toBeUndefined();
  });
});

describe("Client Action arguments", () => {
  const scope = {
    input: { text: "hi" },
    vars: { media: "med_x", camera: "cam_x" },
    memory: {},
    nodes: {},
  };

  it("renders templates inside the JSON args", () => {
    const result = renderClientActionArgs('{"media_id":"{{vars.media}}"}', scope);
    expect(result).toEqual({ ok: true, value: { media_id: "med_x" } });
  });

  it("reports invalid JSON and non-object values", () => {
    expect(renderClientActionArgs('{"media_id":', scope).ok).toBe(false);
    expect(renderClientActionArgs("[1,2]", scope).ok).toBe(false);
  });
});

describe("agent client-tool state machine", () => {
  function llmGraph() {
    const start = node("start");
    const llm = node("llm", {
      model: "inherit",
      outputVariable: "answer",
      clientTools: { mode: "all", names: [] },
    });
    const end = node("end");
    return flow(
      [start, llm, end],
      [
        [start.id, llm.id],
        [llm.id, end.id],
      ],
    );
  }

  it("pauses on a client tool call and resumes from the same checkpoint", async () => {
    const checkpointer = new MemorySaver();
    const counter = { calls: 0 };
    const sessionId = "22222222-2222-4222-8222-222222222222";
    const graph = llmGraph();
    const deps = {
      memory: createInMemoryMemoryStore(),
      fetchImpl: toolCallingFetch(counter),
    };

    const paused = await runAgent({
      flowId: "agt_pause",
      version: 1,
      graph,
      sessionId,
      messages: sessionMessages("show me"),
      inputText: "show me",
      route,
      signal: new AbortController().signal,
      clientTools: [showImage],
      deps,
      checkpointer,
    });
    expect(paused.status).toBe("paused");
    expect(paused.trace.paused).toBe(true);
    expect(paused.toolCalls?.map((call) => call.name)).toEqual(["show_image"]);
    expect(paused.trace.steps.map((step) => step.node_type)).toContain("client_wait");
    expect(paused.trace.steps.at(-1)?.title).toBe("Paused (waiting for client)");

    const resumed = await runAgent({
      flowId: "agt_pause",
      version: 1,
      graph,
      sessionId,
      messages: resumedMessages("show me"),
      inputText: "show me",
      route,
      signal: new AbortController().signal,
      clientTools: [showImage],
      deps,
      checkpointer,
    });
    expect(resumed.status).toBe("ok");
    expect(resumed.reply).toBe("Done: image shown.");
    expect(resumed.trace.steps.map((step) => step.title)).toContain("Resumed");
    expect(counter.calls).toBe(2);
  });

  it("abandons a paused run when a new user message arrives", async () => {
    const checkpointer = new MemorySaver();
    const counter = { calls: 0 };
    const sessionId = "33333333-3333-4333-8333-333333333333";
    const graph = llmGraph();
    const deps = {
      memory: createInMemoryMemoryStore(),
      fetchImpl: toolCallingFetch(counter),
    };

    const paused = await runAgent({
      flowId: "agt_abandon",
      version: 1,
      graph,
      sessionId,
      messages: sessionMessages("first"),
      inputText: "first",
      route,
      signal: new AbortController().signal,
      clientTools: [showImage],
      deps,
      checkpointer,
    });
    expect(paused.status).toBe("paused");

    const fresh = await runAgent({
      flowId: "agt_abandon",
      version: 1,
      graph,
      sessionId,
      messages: [
        { role: "user", content: "first" },
        { role: "user", content: "second" },
      ],
      inputText: "second",
      route,
      signal: new AbortController().signal,
      clientTools: [showImage],
      deps,
      checkpointer,
    });
    expect(fresh.status).toBe("paused");
    expect(counter.calls).toBe(2);
  });
});

describe("Client Action executor", () => {
  function state(overrides: Partial<AgentState> = {}): AgentState {
    return {
      messages: [{ role: "user", content: "hi" }],
      sessionId: "44444444-4444-4444-8444-444444444444",
      vars: {},
      memory: {},
      output: null,
      cursor: "out",
      trace: [],
      text: "",
      reasoning: "",
      lastError: "",
      fatal: false,
      failedNodeId: null,
      pendingClientNode: "",
      pendingClientCalls: [],
      clientResults: [],
      clientResultsNode: "",
      ...overrides,
    };
  }

  function context(): AgentRunContext {
    return {
      flowId: "agt_action",
      version: 1,
      sessionId: "44444444-4444-4444-8444-444444444444",
      graph: { nodes: [], edges: [] },
      inputText: "hi",
      terminalLlmNodes: new Set(),
      route: undefined,
      deps: {
        resolveRoute: async () => undefined,
        mcpToolsByIds: async () => [],
        mcpCall: async () => ({ text: "ok", isError: false }),
        webhookHeaders: async () => ({}),
        memory: createInMemoryMemoryStore(),
        loadSubflowVersion: async () => undefined,
      },
      emitText: () => {},
      signal: new AbortController().signal,
      threadId: "44444444-4444-4444-8444-444444444444",
      pinnedSubflows: {},
      depth: 0,
    };
  }

  it("renders its args template into the pending call", async () => {
    const action = node("client_action", {
      toolName: "show_image",
      argsTemplate: '{"media_id":"{{vars.media}}"}',
      outputVariable: "shown",
    });
    const result = await executeNode(action, state({ vars: { media: "med_a" } }), context());
    expect(result.pendingClientNode).toBe(action.id);
    expect(result.pendingClientCalls?.[0]?.name).toBe("show_image");
    expect(JSON.parse(result.pendingClientCalls?.[0]?.arguments ?? "{}")).toEqual({
      media_id: "med_a",
    });
  });

  it("stores a successful result and routes ok:false down the error handle", async () => {
    const action = node("client_action", { toolName: "show_camera", outputVariable: "shown" });
    const ok = await executeNode(
      action,
      state({
        clientResults: [{ toolCallId: "call_1", content: '{"ok":true,"shown":true}' }],
        clientResultsNode: action.id,
      }),
      context(),
    );
    expect(ok.next).toBe("out");
    expect(ok.vars).toEqual({ shown: { ok: true, shown: true } });

    const failed = await executeNode(
      action,
      state({
        clientResults: [{ toolCallId: "call_1", content: '{"ok":false,"error":"denied"}' }],
        clientResultsNode: action.id,
      }),
      context(),
    );
    expect(failed.next).toBe("error");
    expect(failed.vars).toEqual({ shown: { ok: false, error: "denied" } });
  });
});
