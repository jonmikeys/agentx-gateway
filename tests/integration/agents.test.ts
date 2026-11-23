import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import type { FlowGraph, FlowNode, NodeType } from "@/lib/agents/graph";
import { createFlowNode } from "@/lib/agents/graph";
import { createApiApp } from "@/server/api/app";
import { closeDatabase, getDb } from "@/server/db/client";
import { runLogs, sessionMemory, sessions } from "@/server/db/schema";
import {
  createFlow,
  duplicateFlow,
  getFlow,
  listPublishedAgents,
  publishFlow,
  saveDraft,
  updateFlow,
} from "@/server/services/agents";
import {
  createMcpServer,
  listMcpTools,
  refreshMcpTools,
  setMcpToolAllowed,
} from "@/server/services/mcp";
import { deleteSessionsByIds } from "@/server/services/session-maintenance";
import { findSessionDetail } from "@/server/services/session-queries";
import { type MockMcp, startMockMcp } from "../support/mock-mcp";
import { type MockUpstream, startMockUpstream } from "../support/mock-upstream";
import { type MockWebhook, startMockWebhook } from "../support/mock-webhook";
import {
  prepareDatabase,
  resetGatewayState,
  seedApiKey,
  seedProvider,
  seedRoute,
  waitFor,
} from "./support";

const databaseUrl = inject("databaseUrl");

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

function sseText(body: string): string {
  let text = "";
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith("data: ")) continue;
    const data = line.slice(6);
    if (data === "[DONE]") continue;
    const parsed = JSON.parse(data) as {
      choices?: { delta?: { content?: string } }[];
      error?: unknown;
    };
    const delta = parsed.choices?.[0]?.delta?.content;
    if (typeof delta === "string") text += delta;
  }
  return text;
}

describe("agents: chatflow runtime and client API", () => {
  const app = createApiApp();
  let upstream: MockUpstream;
  let mcp: MockMcp;
  let webhook: MockWebhook;
  let key: string;
  let providerId: string;
  let routeSlug: string;
  let intentRoute: string;
  let counter = 0;

  beforeAll(async () => {
    await prepareDatabase(databaseUrl);
    upstream = await startMockUpstream();
    mcp = await startMockMcp();
    webhook = await startMockWebhook();
  });

  afterAll(async () => {
    await resetGatewayState();
    await upstream.close();
    await mcp.close();
    await webhook.close();
    await closeDatabase();
  });

  beforeEach(async () => {
    await resetGatewayState();
    upstream.reset();
    mcp.reset();
    webhook.reset();
    const provider = await seedProvider("Agent mock", upstream.url);
    providerId = provider.id;
    routeSlug = `agent-route-${counter}`;
    intentRoute = `agent-intent-${counter}`;
    counter += 1;
    await seedRoute(routeSlug, [{ providerId: provider.id, model: "ok" }]);
    await seedRoute(intentRoute, [{ providerId: provider.id, model: "echo" }]);
    key = (await seedApiKey()).key;
  });

  async function publish(nodes: FlowNode[], edges: [string, string, string?][]) {
    const flow = await createFlow({
      name: `Agent ${counter}`,
      slug: `agent-${counter}-${Date.now().toString(36)}`,
      kind: "agent",
      description: "",
      enabled: true,
      settings: {
        default_route_slug: routeSlug,
        allowed_media_tags: [],
        allowed_cameras: [],
      },
    });
    counter += 1;
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

  function llmFlow(overrides: Record<string, unknown> = {}) {
    const start = node("start");
    const llm = node("llm", { model: "inherit", outputVariable: "answer", ...overrides });
    const end = node("end");
    return {
      nodes: [start, llm, end],
      edges: [
        [start.id, llm.id],
        [llm.id, end.id],
      ] as [string, string, string?][],
    };
  }

  it("lists published agents on /v1/agents and /agents and in /v1/models", async () => {
    const { nodes, edges } = llmFlow();
    const id = await publish(nodes, edges);
    for (const path of ["/v1/agents", "/agents"]) {
      const response = await app.request(path, { headers: { Authorization: `Bearer ${key}` } });
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        object: string;
        data: { id: string; object: string }[];
      };
      expect(body.object).toBe("list");
      expect(body.data).toContainEqual(expect.objectContaining({ id, object: "agent" }));
    }
    const models = (await (
      await app.request("/v1/models", { headers: { Authorization: `Bearer ${key}` } })
    ).json()) as { data: { id: string }[] };
    expect(models.data.map((entry) => entry.id)).toContain(`agent:${id}`);
    expect((await listPublishedAgents()).map((agent) => agent.id)).toContain(id);
  });

  it("runs a published agent over chat, streaming and JSON, and links a run log", async () => {
    const { nodes, edges } = llmFlow();
    const id = await publish(nodes, edges);

    const json = await chat({ agent_id: id, messages: [{ role: "user", content: "Hi" }] });
    expect(json.status).toBe(200);
    const sessionId = json.headers.get("x-session-id") as string;
    expect(sessionId).toBeTruthy();
    const body = (await json.json()) as { choices: { message: { content: string } }[] };
    expect(body.choices[0].message.content).toBe("Hello there");

    const streamed = await chat({
      model: `agent:${id}`,
      stream: true,
      messages: [{ role: "user", content: "Hi again" }],
    });
    expect(streamed.status).toBe(200);
    expect(streamed.headers.get("content-type")).toContain("text/event-stream");
    expect(sseText(await streamed.text())).toBe("Hello there");

    const log = await waitFor(async () => {
      const rows = await getDb().select().from(runLogs).where(eq(runLogs.sessionId, sessionId));
      return rows[0];
    });
    expect(log.flowId).toBe(id);
    expect(log.status).toBe("ok");
    expect(log.turnId).not.toBeNull();
    expect(log.trace?.steps.map((step) => step.node_type)).toEqual(["start", "llm", "end"]);

    const detail = await findSessionDetail(sessionId);
    expect(detail?.run_logs.length).toBeGreaterThan(0);
    expect(detail?.run_logs[0].trace?.steps.length).toBe(3);
    expect(detail?.agent_id).toBe(id);
  });

  it("runs a published agent over the Responses API", async () => {
    const { nodes, edges } = llmFlow();
    const id = await publish(nodes, edges);
    const response = await responses({
      model: `agent:${id}`,
      input: [{ role: "user", content: "Hello" }],
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      object: string;
      output: { type: string; content?: { type: string; text: string }[] }[];
    };
    expect(body.object).toBe("response");
    const message = body.output.find((item) => item.type === "message");
    expect(message?.content?.[0]?.text).toBe("Hello there");

    const streamed = await responses({
      model: `agent:${id}`,
      stream: true,
      input: "Hello again",
    });
    expect(streamed.status).toBe(200);
    const events = (await streamed.text())
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)) as { type: string; delta?: string });
    const text = events
      .filter((event) => event.type === "response.output_text.delta")
      .map((event) => event.delta ?? "")
      .join("");
    expect(text).toBe("Hello there");
    expect(events.at(-1)?.type).toBe("response.completed");
  });

  it("rejects an unknown or disabled agent with 400 invalid_agent and no session", async () => {
    const response = await chat({
      agent_id: "agt_000000000000",
      messages: [{ role: "user", content: "Hi" }],
    });
    expect(response.status).toBe(400);
    expect(response.headers.get("x-session-id")).toBeNull();
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "invalid_agent",
    );

    const { nodes, edges } = llmFlow();
    const id = await publish(nodes, edges);
    await getFlow(id);
    await updateFlow(id, { enabled: false });
    const disabled = await chat({
      agent_id: id,
      messages: [{ role: "user", content: "Hi" }],
    });
    expect(disabled.status).toBe(400);
    expect(((await disabled.json()) as { error: { code: string } }).error.code).toBe(
      "invalid_agent",
    );
  });

  it("ends the session with agent_changed when the agent differs", async () => {
    await seedRoute("plain-agent-route", [{ providerId, model: "ok" }]);
    const plain = await chat({
      model: "plain-agent-route",
      messages: [{ role: "user", content: "Hi" }],
    });
    expect(plain.status).toBe(200);
    const plainSession = plain.headers.get("x-session-id") as string;

    const { nodes, edges } = llmFlow();
    const id = await publish(nodes, edges);
    const agent = await chat(
      { agent_id: id, messages: [{ role: "user", content: "Hi agent" }] },
      { "X-Session-Id": plainSession },
    );
    expect(agent.status).toBe(200);
    const newSession = agent.headers.get("x-session-id") as string;
    expect(newSession).not.toBe(plainSession);
    const [old] = await getDb().select().from(sessions).where(eq(sessions.id, plainSession));
    expect(old.status).toBe("ended");
    expect(old.endReason).toBe("agent_changed");
  });

  it("persists Memory node values across turns of one session", async () => {
    const start = node("start");
    const append = node("memory", {
      operation: "append",
      key: "log",
      value: "{{input.text}}",
      outputVariable: "ignored",
    });
    const read = node("memory", { operation: "get", key: "log", outputVariable: "log" });
    const reply = node("reply", { template: "{{vars.log}}" });
    const end = node("end");
    const id = await publish(
      [start, append, read, reply, end],
      [
        [start.id, append.id],
        [append.id, read.id],
        [read.id, reply.id],
        [reply.id, end.id],
      ],
    );

    const first = await chat({ agent_id: id, messages: [{ role: "user", content: "Ada" }] });
    const sessionId = first.headers.get("x-session-id") as string;
    expect(
      ((await first.json()) as { choices: { message: { content: string } }[] }).choices[0].message
        .content,
    ).toBe("Ada");

    const second = await chat(
      {
        agent_id: id,
        messages: [
          { role: "user", content: "Ada" },
          { role: "assistant", content: "Ada" },
          { role: "user", content: "Grace" },
        ],
      },
      { "X-Session-Id": sessionId },
    );
    expect(second.status).toBe(200);
    expect(
      ((await second.json()) as { choices: { message: { content: string } }[] }).choices[0].message
        .content,
    ).toBe("Ada\nGrace");

    const memory = await getDb()
      .select()
      .from(sessionMemory)
      .where(eq(sessionMemory.sessionId, sessionId));
    expect(memory).toContainEqual(expect.objectContaining({ key: "log", value: "Ada\nGrace" }));
    const detail = await findSessionDetail(sessionId);
    expect(detail?.memory).toContainEqual(expect.objectContaining({ key: "log" }));
  });

  it("calls a Webhook node, maps its JSON and follows the success path", async () => {
    const start = node("start");
    const hook = node("webhook", {
      method: "GET",
      url: `${webhook.url}/hook`,
      mappings: [{ variable: "hook_value", path: "data.value" }],
      outputVariable: "payload",
    });
    const reply = node("reply", { template: "Value: {{vars.hook_value}}" });
    const end = node("end");
    const id = await publish(
      [start, hook, reply, end],
      [
        [start.id, hook.id],
        [hook.id, reply.id],
        [reply.id, end.id],
      ],
    );
    const response = await chat({ agent_id: id, messages: [{ role: "user", content: "Go" }] });
    const body = (await response.json()) as { choices: { message: { content: string } }[] };
    expect(body.choices[0].message.content).toBe("Value: hook-value");
    expect(webhook.calls.some((call) => call.path === "/hook")).toBe(true);
  });

  it("follows the Webhook error branch and retries 5xx responses", async () => {
    const start = node("start");
    const hook = node("webhook", {
      method: "GET",
      url: `${webhook.url}/fail`,
      retries: 1,
      outputVariable: "failed",
    });
    const fallback = node("reply", { template: "Fallback reply" });
    const end = node("end");
    const id = await publish(
      [start, hook, fallback, end],
      [
        [start.id, hook.id],
        [hook.id, fallback.id, "error"],
        [hook.id, end.id],
        [fallback.id, end.id],
      ],
    );
    const response = await chat({ agent_id: id, messages: [{ role: "user", content: "Go" }] });
    const body = (await response.json()) as { choices: { message: { content: string } }[] };
    expect(body.choices[0].message.content).toBe("Fallback reply");
    expect(webhook.calls.filter((call) => call.path === "/fail")).toHaveLength(2);

    webhook.reset();
    const retryStart = node("start");
    const retryHook = node("webhook", {
      method: "GET",
      url: `${webhook.url}/retry`,
      retries: 2,
      outputVariable: "result",
    });
    const retryReply = node("reply", { template: "Attempts: {{vars.result.attempts}}" });
    const retryEnd = node("end");
    const retryId = await publish(
      [retryStart, retryHook, retryReply, retryEnd],
      [
        [retryStart.id, retryHook.id],
        [retryHook.id, retryReply.id],
        [retryReply.id, retryEnd.id],
      ],
    );
    const retried = await chat({
      agent_id: retryId,
      messages: [{ role: "user", content: "Go" }],
    });
    const retriedBody = (await retried.json()) as {
      choices: { message: { content: string } }[];
    };
    expect(retriedBody.choices[0].message.content).toBe("Attempts: 3");
    expect(webhook.calls.filter((call) => call.path === "/retry")).toHaveLength(3);
  });

  it("calls an MCP Tool node with an allowed tool", async () => {
    const server = await createMcpServer({
      name: "Agent MCP",
      slug: `agentmcp${counter}`,
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
    const tool = node("mcp_tool", {
      serverId: server.id,
      toolName: "echo",
      args: [{ name: "text", value: "{{input.text}}" }],
      outputVariable: "echoed",
    });
    const reply = node("reply", { template: "{{vars.echoed}}" });
    const end = node("end");
    const id = await publish(
      [start, tool, reply, end],
      [
        [start.id, tool.id],
        [tool.id, reply.id],
        [reply.id, end.id],
      ],
    );
    const response = await chat({
      agent_id: id,
      messages: [{ role: "user", content: "ping" }],
    });
    const body = (await response.json()) as { choices: { message: { content: string } }[] };
    expect(body.choices[0].message.content).toBe("Echo: ping");
    expect(mcp.calls).toContainEqual({ tool: "echo", args: { text: "ping" } });
    counter += 1;
  });

  it("branches with Router rules and with an intent picked by the LLM", async () => {
    const start = node("start");
    const router = node("router", {
      mode: "rules",
      rules: [
        {
          id: "weather",
          label: "Weather",
          operator: "contains",
          subject: "{{input.text}}",
          value: "weather",
        },
      ],
      defaultLabel: "Other",
    });
    const weatherReply = node("reply", { template: "Weather reply" });
    const otherReply = node("reply", { template: "Other reply" });
    const end = node("end");
    const rulesId = await publish(
      [start, router, weatherReply, otherReply, end],
      [
        [start.id, router.id],
        [router.id, weatherReply.id, "weather"],
        [router.id, otherReply.id, "default"],
        [weatherReply.id, end.id],
        [otherReply.id, end.id],
      ],
    );
    const weather = await chat({
      agent_id: rulesId,
      messages: [{ role: "user", content: "What is the weather?" }],
    });
    expect(
      ((await weather.json()) as { choices: { message: { content: string } }[] }).choices[0].message
        .content,
    ).toBe("Weather reply");
    const other = await chat({ agent_id: rulesId, messages: [{ role: "user", content: "Hello" }] });
    expect(
      ((await other.json()) as { choices: { message: { content: string } }[] }).choices[0].message
        .content,
    ).toBe("Other reply");

    const intentStart = node("start");
    const intent = node("router", {
      mode: "intent",
      model: intentRoute,
      intentLabels: ["greet"],
      defaultLabel: "other",
    });
    const greetReply = node("reply", { template: "Greeting reply" });
    const fallbackReply = node("reply", { template: "Fallback reply" });
    const intentEnd = node("end");
    const intentId = await publish(
      [intentStart, intent, greetReply, fallbackReply, intentEnd],
      [
        [intentStart.id, intent.id],
        [intent.id, greetReply.id, "intent:greet"],
        [intent.id, fallbackReply.id, "default"],
        [greetReply.id, intentEnd.id],
        [fallbackReply.id, intentEnd.id],
      ],
    );
    const greeted = await chat({
      agent_id: intentId,
      messages: [{ role: "user", content: "greet me" }],
    });
    const greetedBody = (await greeted.json()) as {
      choices: { message: { content: string } }[];
    };
    expect(greetedBody.choices[0].message.content).toBe("Greeting reply");
    expect(upstream.chatRequests().some((request) => request.body?.model === "echo")).toBe(true);
  });

  it("purges run logs and session memory with the session", async () => {
    const start = node("start");
    const setter = node("memory", {
      operation: "set",
      key: "keep",
      value: "yes",
      outputVariable: "x",
    });
    const reply = node("reply", { template: "done" });
    const end = node("end");
    const id = await publish(
      [start, setter, reply, end],
      [
        [start.id, setter.id],
        [setter.id, reply.id],
        [reply.id, end.id],
      ],
    );
    const response = await chat({ agent_id: id, messages: [{ role: "user", content: "Go" }] });
    const sessionId = response.headers.get("x-session-id") as string;
    await waitFor(async () => {
      const rows = await getDb().select().from(runLogs).where(eq(runLogs.sessionId, sessionId));
      return rows.length > 0 ? rows[0] : undefined;
    });
    expect(
      await getDb().select().from(sessionMemory).where(eq(sessionMemory.sessionId, sessionId)),
    ).toHaveLength(1);

    await deleteSessionsByIds([sessionId]);
    expect(
      await getDb().select().from(runLogs).where(eq(runLogs.sessionId, sessionId)),
    ).toHaveLength(0);
    expect(
      await getDb().select().from(sessionMemory).where(eq(sessionMemory.sessionId, sessionId)),
    ).toHaveLength(0);
  });

  it("duplicates the draft, settings and sticky notes", async () => {
    const start = node("start");
    const reply = node("reply", { template: "hi" });
    const end = node("end");
    const note: FlowNode = {
      id: "note_duplicate",
      type: "note",
      position: { x: 0, y: 200 },
      width: 240,
      height: 160,
      data: { title: "Remember", markdown: "note body", color: "pink" },
    } as FlowNode;
    const flow = await createFlow({
      name: `Duplicate ${counter}`,
      slug: `duplicate-${counter}-${Date.now().toString(36)}`,
      kind: "agent",
      description: "copy me",
      enabled: true,
      settings: {
        default_route_slug: routeSlug,
        allowed_media_tags: ["framed"],
        allowed_cameras: ["lobby"],
      },
    });
    counter += 1;
    await saveDraft(
      flow.id,
      graph(
        [start, reply, end, note],
        [
          [start.id, reply.id],
          [reply.id, end.id],
        ],
      ),
    );

    const copy = await duplicateFlow(flow.id);
    expect(copy.draft.nodes.some((entry) => entry.type === "note")).toBe(true);
    expect(copy.draft.nodes.find((entry) => entry.type === "note")?.data).toMatchObject({
      title: "Remember",
      color: "pink",
    });
    expect(copy.settings.default_route_slug).toBe(routeSlug);
    expect(copy.settings.allowed_media_tags).toEqual(["framed"]);
    expect(copy.settings.allowed_cameras).toEqual(["lobby"]);
    expect(copy.enabled).toBe(false);
    expect(copy.published_version).toBeNull();
  });
});
