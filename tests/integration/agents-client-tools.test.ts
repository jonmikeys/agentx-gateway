import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import type { FlowGraph, FlowNode, NodeType } from "@/lib/agents/graph";
import { createFlowNode } from "@/lib/agents/graph";
import { registerAgentPurgeHooks } from "@/server/agents/purge";
import { createApiApp } from "@/server/api/app";
import { closeDatabase, getDb } from "@/server/db/client";
import { cameras, mediaItems } from "@/server/db/schema";
import {
  createFlow,
  publishFlow,
  resolveAgentRestrictions,
  saveDraft,
} from "@/server/services/agents";
import {
  createMcpServer,
  listMcpTools,
  refreshMcpTools,
  setMcpToolAllowed,
} from "@/server/services/mcp";
import { deleteSessionsByIds } from "@/server/services/session-maintenance";
import { type MockMcp, startMockMcp } from "../support/mock-mcp";
import { type MockUpstream, startMockUpstream } from "../support/mock-upstream";
import { prepareDatabase, resetGatewayState, seedApiKey, seedProvider, seedRoute } from "./support";

const databaseUrl = inject("databaseUrl");

const MEDIA_ALLOWED = "med_aaaaaaaaaaaa";
const MEDIA_OTHER = "med_bbbbbbbbbbbb";
const CAMERA_ALLOWED = "cam_aaaaaaaaaaaa";

const showImageTool = {
  type: "function",
  function: {
    name: "show_image",
    description: "Show an image.",
    parameters: {
      type: "object",
      properties: {
        media_id: { type: "string", enum: [MEDIA_ALLOWED, MEDIA_OTHER] },
      },
      required: ["media_id"],
    },
  },
};

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

interface ChatBody {
  choices: { message: { content: string | null; tool_calls?: unknown[] }; finish_reason: string }[];
}

describe("agents: client tools, Client Action and restrictions", () => {
  const app = createApiApp();
  let upstream: MockUpstream;
  let mcp: MockMcp;
  let key: string;
  let providerId: string;
  let counter = 0;

  beforeAll(async () => {
    await prepareDatabase(databaseUrl);
    registerAgentPurgeHooks();
    upstream = await startMockUpstream();
    mcp = await startMockMcp();
  });

  afterAll(async () => {
    await resetGatewayState();
    await upstream.close();
    await mcp.close();
    await closeDatabase();
  });

  beforeEach(async () => {
    await resetGatewayState();
    upstream.reset();
    mcp.reset();
    const provider = await seedProvider("Client mock", upstream.url);
    providerId = provider.id;
    key = (await seedApiKey()).key;
    await getDb()
      .insert(mediaItems)
      .values([
        {
          id: MEDIA_ALLOWED,
          name: "Allowed",
          kind: "image",
          tags: ["allowed"],
          enabled: true,
          source: "external_url",
          externalUrl: "https://example.com/allowed.png",
          mimeType: "image/png",
        },
        {
          id: MEDIA_OTHER,
          name: "Other",
          kind: "image",
          tags: ["other"],
          enabled: true,
          source: "external_url",
          externalUrl: "https://example.com/other.png",
          mimeType: "image/png",
        },
      ]);
    await getDb().insert(cameras).values({
      id: CAMERA_ALLOWED,
      name: "Lobby",
      enabled: true,
      type: "lookat_sidecar",
      config: {},
    });
  });

  async function publish(
    nodes: FlowNode[],
    edges: [string, string, string?][],
    settings: { model: string; tags?: string[]; cameras?: string[] },
  ) {
    const routeSlug = `client-route-${counter}`;
    counter += 1;
    await seedRoute(routeSlug, [{ providerId, model: settings.model }]);
    const flow = await createFlow({
      name: `Client agent ${counter}`,
      slug: `client-agent-${counter}-${Date.now().toString(36)}`,
      kind: "agent",
      description: "",
      enabled: true,
      settings: {
        default_route_slug: routeSlug,
        allowed_media_tags: settings.tags ?? [],
        allowed_cameras: settings.cameras ?? [],
      },
    });
    await saveDraft(flow.id, graph(nodes, edges));
    await publishFlow(flow.id, "test");
    return flow.id;
  }

  function chat(body: Record<string, unknown>, headers: Record<string, string> = {}) {
    return app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    });
  }

  function responses(body: Record<string, unknown>, headers: Record<string, string> = {}) {
    return app.request("/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    });
  }

  function llmFlow(clientTools = { mode: "all", names: [] as string[] }) {
    const start = node("start");
    const llm = node("llm", { model: "inherit", outputVariable: "answer", clientTools });
    const end = node("end");
    return {
      nodes: [start, llm, end],
      edges: [
        [start.id, llm.id],
        [llm.id, end.id],
      ] as [string, string, string?][],
    };
  }

  function toolCallMessage(callId: string, name: string, args: string) {
    return {
      role: "assistant",
      content: null,
      tool_calls: [{ id: callId, type: "function", function: { name, arguments: args } }],
    };
  }

  it("pauses on a client tool call over chat and resumes with the tool result", async () => {
    const { nodes, edges } = llmFlow();
    const id = await publish(nodes, edges, { model: "tool-call" });

    const first = await chat({
      agent_id: id,
      messages: [{ role: "user", content: "Show a sunset" }],
      tools: [showImageTool],
    });
    expect(first.status).toBe(200);
    const sessionId = first.headers.get("x-session-id") as string;
    const firstBody = (await first.json()) as ChatBody;
    expect(firstBody.choices[0].finish_reason).toBe("tool_calls");
    const call = (
      firstBody.choices[0].message.tool_calls as {
        id: string;
        function: { name: string; arguments: string };
      }[]
    )[0];
    expect(call.function.name).toBe("show_image");
    expect(JSON.parse(call.function.arguments)).toEqual({ media_id: "sunset" });

    const second = await chat(
      {
        agent_id: id,
        messages: [
          { role: "user", content: "Show a sunset" },
          toolCallMessage(call.id, "show_image", call.function.arguments),
          { role: "tool", tool_call_id: call.id, content: '{"ok":true}' },
        ],
        tools: [showImageTool],
      },
      { "X-Session-Id": sessionId },
    );
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as ChatBody;
    expect(secondBody.choices[0].message.content).toBe("Done! I put the image on screen.");
  });

  it("pauses and resumes over the Responses API", async () => {
    const { nodes, edges } = llmFlow();
    const id = await publish(nodes, edges, { model: "tool-call" });

    const first = await responses({
      agent_id: id,
      input: [{ role: "user", content: "Show a sunset" }],
      tools: [
        {
          type: "function",
          name: "show_image",
          description: "Show an image.",
          parameters: showImageTool.function.parameters,
        },
      ],
    });
    expect(first.status).toBe(200);
    const sessionId = first.headers.get("x-session-id") as string;
    const firstBody = (await first.json()) as {
      output: { type: string; call_id?: string; name?: string; arguments?: string }[];
    };
    const call = firstBody.output.find((item) => item.type === "function_call");
    expect(call?.name).toBe("show_image");

    const second = await responses(
      {
        agent_id: id,
        input: [
          { type: "message", role: "user", content: "Show a sunset" },
          {
            type: "function_call",
            call_id: call?.call_id,
            name: "show_image",
            arguments: call?.arguments,
          },
          { type: "function_call_output", call_id: call?.call_id, output: '{"ok":true}' },
        ],
        tools: [
          {
            type: "function",
            name: "show_image",
            description: "Show an image.",
            parameters: showImageTool.function.parameters,
          },
        ],
      },
      { "X-Session-Id": sessionId },
    );
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as {
      output: { type: string; content?: { type: string; text: string }[] }[];
    };
    const message = secondBody.output.find((item) => item.type === "message");
    expect(message?.content?.[0]?.text).toBe("Done! I put the image on screen.");
  });

  it("round-trips a Client Action and follows its error branch", async () => {
    const start = node("start");
    const action = node("client_action", {
      toolName: "show_image",
      argsTemplate: `{"media_id":"${MEDIA_ALLOWED}"}`,
      outputVariable: "shown",
    });
    const okReply = node("reply", { template: "Shown: {{vars.shown.ok}}" });
    const errorReply = node("reply", { template: "Denied: {{vars.shown.error}}" });
    const end = node("end");
    const id = await publish(
      [start, action, okReply, errorReply, end],
      [
        [start.id, action.id],
        [action.id, okReply.id],
        [action.id, errorReply.id, "error"],
        [okReply.id, end.id],
        [errorReply.id, end.id],
      ],
      { model: "ok" },
    );

    const first = await chat({ agent_id: id, messages: [{ role: "user", content: "Go" }] });
    const sessionId = first.headers.get("x-session-id") as string;
    const firstBody = (await first.json()) as ChatBody;
    const call = (
      firstBody.choices[0].message.tool_calls as {
        id: string;
        function: { name: string; arguments: string };
      }[]
    )[0];
    expect(call.function.name).toBe("show_image");
    expect(JSON.parse(call.function.arguments)).toEqual({ media_id: MEDIA_ALLOWED });

    const resumed = await chat(
      {
        agent_id: id,
        messages: [
          { role: "user", content: "Go" },
          toolCallMessage(call.id, "show_image", call.function.arguments),
          { role: "tool", tool_call_id: call.id, content: '{"ok":true}' },
        ],
      },
      { "X-Session-Id": sessionId },
    );
    expect(((await resumed.json()) as ChatBody).choices[0].message.content).toBe("Shown: true");

    // A failing result takes the error handle on a fresh session.
    const fresh = await chat({ agent_id: id, messages: [{ role: "user", content: "Go" }] });
    const freshSession = fresh.headers.get("x-session-id") as string;
    const freshCall = ((await fresh.json()) as ChatBody).choices[0].message.tool_calls as {
      id: string;
      function: { arguments: string };
    }[];
    const failed = await chat(
      {
        agent_id: id,
        messages: [
          { role: "user", content: "Go" },
          toolCallMessage(freshCall[0].id, "show_image", freshCall[0].function.arguments),
          {
            role: "tool",
            tool_call_id: freshCall[0].id,
            content: '{"ok":false,"error":"denied"}',
          },
        ],
      },
      { "X-Session-Id": freshSession },
    );
    expect(((await failed.json()) as ChatBody).choices[0].message.content).toBe("Denied: denied");
  });

  it("executes MCP calls server-side and pauses only for the client calls", async () => {
    const server = await createMcpServer({
      name: "Client MCP",
      slug: `clientmcp${counter}`,
      url: mcp.url,
      transport: "streamable_http",
      headers: null,
      enabled: true,
    });
    await refreshMcpTools(server.id);
    const tools = await listMcpTools(server.id);
    const echo = tools.find((tool) => tool.name === "echo");
    if (!echo) throw new Error("echo tool missing");
    await setMcpToolAllowed(echo.id, true);

    const start = node("start");
    const llm = node("llm", {
      model: "inherit",
      outputVariable: "answer",
      mcpToolIds: [echo.id],
      clientTools: { mode: "all", names: [] },
    });
    const end = node("end");
    const id = await publish(
      [start, llm, end],
      [
        [start.id, llm.id],
        [llm.id, end.id],
      ],
      { model: "mcp-mixed" },
    );

    const first = await chat({
      agent_id: id,
      messages: [{ role: "user", content: "Mix it" }],
      tools: [showImageTool],
    });
    const sessionId = first.headers.get("x-session-id") as string;
    const body = (await first.json()) as ChatBody;
    const calls = body.choices[0].message.tool_calls as {
      id: string;
      function: { name: string; arguments: string };
    }[];
    expect(calls).toHaveLength(1);
    expect(calls[0].function.name).toBe("show_image");
    expect(mcp.calls).toContainEqual({ tool: "echo", args: { text: "mixed" } });

    const resumed = await chat(
      {
        agent_id: id,
        messages: [
          { role: "user", content: "Mix it" },
          toolCallMessage(calls[0].id, "show_image", calls[0].function.arguments),
          { role: "tool", tool_call_id: calls[0].id, content: '{"ok":true}' },
        ],
        tools: [showImageTool],
      },
      { "X-Session-Id": sessionId },
    );
    expect(((await resumed.json()) as ChatBody).choices[0].message.content).toBe("Mixed done.");
  });

  it("abandons a paused run when a new user message arrives", async () => {
    const start = node("start");
    const action = node("client_action", {
      toolName: "show_image",
      argsTemplate: `{"media_id":"${MEDIA_ALLOWED}"}`,
      outputVariable: "shown",
    });
    const reply = node("reply", { template: "done" });
    const end = node("end");
    const id = await publish(
      [start, action, reply, end],
      [
        [start.id, action.id],
        [action.id, reply.id],
        [reply.id, end.id],
      ],
      { model: "ok" },
    );

    const first = await chat({ agent_id: id, messages: [{ role: "user", content: "first" }] });
    const sessionId = first.headers.get("x-session-id") as string;
    const firstCall = ((await first.json()) as ChatBody).choices[0].message.tool_calls as {
      id: string;
    }[];

    const second = await chat(
      {
        agent_id: id,
        messages: [
          { role: "user", content: "first" },
          { role: "user", content: "second" },
        ],
      },
      { "X-Session-Id": sessionId },
    );
    const secondCall = ((await second.json()) as ChatBody).choices[0].message.tool_calls as {
      id: string;
    }[];
    expect(secondCall[0].id).not.toBe(firstCall[0].id);
  });

  it("purges checkpoints of a paused run with the session", async () => {
    const start = node("start");
    const action = node("client_action", {
      toolName: "show_image",
      argsTemplate: `{"media_id":"${MEDIA_ALLOWED}"}`,
      outputVariable: "shown",
    });
    const reply = node("reply", { template: "done" });
    const end = node("end");
    const id = await publish(
      [start, action, reply, end],
      [
        [start.id, action.id],
        [action.id, reply.id],
        [reply.id, end.id],
      ],
      { model: "ok" },
    );
    const paused = await chat({ agent_id: id, messages: [{ role: "user", content: "go" }] });
    const sessionId = paused.headers.get("x-session-id") as string;
    const before = await getDb().execute(
      sql`select count(*)::int as count from checkpoints where thread_id = ${sessionId}`,
    );
    expect((before as unknown as { count: number }[])[0].count).toBeGreaterThan(0);

    await deleteSessionsByIds([sessionId]);
    const after = await getDb().execute(
      sql`select count(*)::int as count from checkpoints where thread_id = ${sessionId}`,
    );
    expect((after as unknown as { count: number }[])[0].count).toBe(0);
  });

  it("narrows client tool enums and rejects Client Actions outside the allowed sets", async () => {
    const { nodes, edges } = llmFlow();
    const id = await publish(nodes, edges, { model: "tool-call", tags: ["allowed"] });
    await chat({
      agent_id: id,
      messages: [{ role: "user", content: "Show" }],
      tools: [showImageTool],
    });
    const request = upstream.chatRequests().at(-1);
    const tools = (request?.body?.tools ?? []) as {
      function: { name: string; parameters: { properties: { media_id: { enum: string[] } } } };
    }[];
    const offered = tools.find((tool) => tool.function.name === "show_image");
    expect(offered?.function.parameters.properties.media_id.enum).toEqual([MEDIA_ALLOWED]);

    const start = node("start");
    const action = node("client_action", {
      toolName: "show_image",
      argsTemplate: `{"media_id":"${MEDIA_OTHER}"}`,
      outputVariable: "shown",
    });
    const end = node("end");
    const invalid = await createFlow({
      name: `Invalid ${counter}`,
      slug: `invalid-client-${counter}-${Date.now().toString(36)}`,
      kind: "agent",
      description: "",
      enabled: true,
      settings: {
        default_route_slug: null,
        allowed_media_tags: ["allowed"],
        allowed_cameras: [],
      },
    });
    counter += 1;
    await saveDraft(
      invalid.id,
      graph(
        [start, action, end],
        [
          [start.id, action.id],
          [action.id, end.id],
        ],
      ),
    );
    await expect(publishFlow(invalid.id, "test")).rejects.toMatchObject({
      code: "flow_invalid",
    });

    const restrictions = await resolveAgentRestrictions({
      default_route_slug: null,
      allowed_media_tags: ["allowed"],
      allowed_cameras: [CAMERA_ALLOWED],
    });
    expect(restrictions).toEqual({ mediaIds: [MEDIA_ALLOWED], cameraIds: [CAMERA_ALLOWED] });
  });
});
