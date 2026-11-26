import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FlowNode, NodeType } from "@/lib/agents/graph";
import { createFlowNode } from "@/lib/agents/graph";
import { AgentRuntimeError } from "@/server/agents/llm";
import { createInMemoryMemoryStore } from "@/server/agents/memory";
import {
  type AgentDependencies,
  type AgentRunContext,
  type AgentState,
  executeNode,
} from "@/server/agents/nodes";
import type { ResolvedRoute } from "@/server/services/routes";

function node(type: NodeType, overrides: Record<string, unknown> = {}): FlowNode {
  return createFlowNode(type, { x: 0, y: 0 }, overrides);
}

function state(overrides: Partial<AgentState> = {}): AgentState {
  return {
    messages: [{ role: "user", content: "hello" }],
    sessionId: "11111111-1111-4111-8111-111111111111",
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

function context(
  overrides: Partial<Omit<AgentRunContext, "deps">> & { deps?: Partial<AgentDependencies> } = {},
): AgentRunContext {
  const base: AgentRunContext = {
    flowId: "agt_test",
    version: 1,
    sessionId: "11111111-1111-4111-8111-111111111111",
    graph: { nodes: [], edges: [] },
    inputText: "hello",
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
    threadId: "11111111-1111-4111-8111-111111111111",
    pinnedSubflows: {},
    depth: 0,
  };
  return { ...base, ...overrides, deps: { ...base.deps, ...overrides.deps } };
}

const route: ResolvedRoute = {
  id: "route-1",
  slug: "test-route",
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

function fetchCompletion(text: string): typeof fetch {
  return (async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }],
        usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )) as typeof fetch;
}

describe("node executors", () => {
  it("sets variables from templates", async () => {
    const result = await executeNode(
      node("set_variable", {
        assignments: [
          { key: "greeting", value: "Hi {{input.text}}" },
          { key: "memoryValue", value: "{{memory.tone}}" },
        ],
      }),
      state({ memory: { tone: "warm" } }),
      context(),
    );
    expect(result.vars).toEqual({ greeting: "Hi hello", memoryValue: "warm" });
  });

  it("streams a Reply template and reports it once", async () => {
    const chunks: string[] = [];
    const result = await executeNode(
      node("reply", { template: "You said {{input.text}}" }),
      state(),
      context({ emitText: (delta) => chunks.push(delta) }),
    );
    expect(chunks.join("")).toBe("You said hello");
    expect(result.emittedText).toBe("You said hello");
  });

  it("reads and writes session memory", async () => {
    const store = createInMemoryMemoryStore();
    const setResult = await executeNode(
      node("memory", { operation: "set", key: "name", value: "Ada", outputVariable: "stored" }),
      state(),
      context({ deps: { memory: store } }),
    );
    expect(setResult.memory).toEqual({ name: "Ada" });

    const loaded = await store.load("11111111-1111-4111-8111-111111111111");
    const getResult = await executeNode(
      node("memory", { operation: "get", key: "name", outputVariable: "recalled" }),
      state({ memory: loaded }),
      context({ deps: { memory: store } }),
    );
    expect(getResult.vars).toEqual({ recalled: "Ada" });

    const appendResult = await executeNode(
      node("memory", {
        operation: "append",
        key: "name",
        value: "Lovelace",
        outputVariable: "joined",
      }),
      state({ memory: loaded }),
      context({ deps: { memory: store } }),
    );
    expect(appendResult.vars).toEqual({ joined: "Ada\nLovelace" });

    await executeNode(
      node("memory", { operation: "delete", key: "name", outputVariable: "gone" }),
      state({ memory: loaded }),
      context({ deps: { memory: store } }),
    );
    expect(await store.load("11111111-1111-4111-8111-111111111111")).toEqual({});
  });

  it("routes with equals, contains, regex and default", async () => {
    const routerNode = node("router", {
      mode: "rules",
      rules: [
        {
          id: "exact",
          label: "Exact",
          operator: "equals",
          subject: "{{input.text}}",
          value: "hello",
        },
        {
          id: "contains",
          label: "Contains",
          operator: "contains",
          subject: "{{input.text}}",
          value: "ell",
        },
        {
          id: "regex",
          label: "Regex",
          operator: "regex",
          subject: "{{input.text}}",
          value: "^h.*o$",
        },
      ],
      defaultLabel: "Other",
    });
    const exact = await executeNode(routerNode, state(), context());
    expect(exact.next).toBe("exact");
    const contains = await executeNode(routerNode, state(), context({ inputText: "well hello" }));
    expect(contains.next).toBe("contains");
    const regex = await executeNode(routerNode, state(), context({ inputText: "hey-o" }));
    expect(regex.next).toBe("regex");
    const fallback = await executeNode(routerNode, state(), context({ inputText: "nope" }));
    expect(fallback.next).toBe("default");
  });

  it("calls an LLM route and stores the output variable", async () => {
    const result = await executeNode(
      node("llm", {
        model: "test-route",
        systemPrompt: "Be brief.",
        history: "full",
        outputVariable: "answer",
      }),
      state(),
      context({
        deps: {
          resolveRoute: async (slug) => (slug === "test-route" ? route : undefined),
          fetchImpl: fetchCompletion("From model"),
        },
      }),
    );
    expect(result.next).toBe("out");
    expect(result.vars).toEqual({ answer: "From model" });
    expect(result.usage?.total_tokens).toBe(5);
  });

  it("uses the inherited route for model: inherit", async () => {
    const result = await executeNode(
      node("llm", { model: "inherit", outputVariable: "answer" }),
      state(),
      context({ route, deps: { fetchImpl: fetchCompletion("Inherited") } }),
    );
    expect(result.vars).toEqual({ answer: "Inherited" });
  });

  it("fails with a clear code when the route is unknown", async () => {
    await expect(
      executeNode(node("llm", { model: "missing-route" }), state(), context()),
    ).rejects.toBeInstanceOf(AgentRuntimeError);
  });

  it("calls an MCP tool node with templated args", async () => {
    const calls: unknown[] = [];
    const result = await executeNode(
      node("mcp_tool", {
        serverId: "22222222-2222-4222-8222-222222222222",
        toolName: "echo",
        args: [{ name: "text", value: "{{input.text}}" }],
        outputVariable: "echoed",
      }),
      state(),
      context({
        deps: {
          mcpCall: async (serverId, toolName, args) => {
            calls.push({ serverId, toolName, args });
            return { text: "Echo: hello", isError: false };
          },
        },
      }),
    );
    expect(calls).toEqual([
      {
        serverId: "22222222-2222-4222-8222-222222222222",
        toolName: "echo",
        args: { text: "hello" },
      },
    ]);
    expect(result.vars).toEqual({ echoed: "Echo: hello" });
  });
});

describe("webhook node", () => {
  let server: Server;
  let url: string;
  let attempts = 0;

  beforeAll(async () => {
    server = createServer((request, response) => {
      const path = (request.url ?? "").split("?")[0];
      response.setHeader("Content-Type", "application/json");
      if (path === "/ok") {
        response.end(JSON.stringify({ data: { value: "mapped", items: [1, 2] } }));
        return;
      }
      if (path === "/retry") {
        attempts += 1;
        if (attempts < 3) {
          response.statusCode = 503;
          response.end(JSON.stringify({ error: "not yet" }));
          return;
        }
        response.end(JSON.stringify({ ok: true }));
        return;
      }
      if (path === "/big") {
        response.end(JSON.stringify({ text: "x".repeat(5000) }));
        return;
      }
      response.statusCode = 500;
      response.end(JSON.stringify({ error: "boom" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("maps a JSON response into variables", async () => {
    const result = await executeNode(
      node("webhook", {
        method: "GET",
        url: `${url}/ok`,
        mappings: [{ variable: "value", path: "data.value" }],
        outputVariable: "payload",
      }),
      state(),
      context({ deps: { webhookHeaders: async () => ({ "X-Test": "1" }) } }),
    );
    expect(result.vars).toEqual({
      payload: { data: { value: "mapped", items: [1, 2] } },
      value: "mapped",
    });
  });

  it("retries a 5xx the configured number of times", async () => {
    attempts = 0;
    const result = await executeNode(
      node("webhook", { method: "GET", url: `${url}/retry`, retries: 2, outputVariable: "out" }),
      state(),
      context(),
    );
    expect(attempts).toBe(3);
    expect(result.vars).toEqual({ out: { ok: true } });
  });

  it("fails after the retries are exhausted", async () => {
    await expect(
      executeNode(
        node("webhook", { method: "GET", url: `${url}/fail`, retries: 1 }),
        state(),
        context(),
      ),
    ).rejects.toMatchObject({ code: "webhook_http_error" });
  });

  it("enforces the response size cap", async () => {
    await expect(
      executeNode(
        node("webhook", { method: "GET", url: `${url}/big`, maxResponseBytes: 1024 }),
        state(),
        context(),
      ),
    ).rejects.toMatchObject({ code: "webhook_response_too_large" });
  });
});
