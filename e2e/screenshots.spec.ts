import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  type APIRequestContext,
  expect,
  request as playwrightRequest,
  test,
} from "@playwright/test";
import dagre from "dagre";
import postgres from "postgres";
import { navGroups } from "../src/components/app-shell/nav";
import { type MockMcp, startMockMcp } from "../tests/support/mock-mcp";
import { type MockSearxng, startMockSearxng } from "../tests/support/mock-searxng";
import { type MockUpstream, startMockUpstream } from "../tests/support/mock-upstream";
import { type MockWebhook, startMockWebhook } from "../tests/support/mock-webhook";
import { type MediaSeed, seedMediaAndCameras } from "./media-seed";

/**
 * Repeatable CRM screenshots (`pnpm screenshots`): every page in nav.ts plus key states,
 * light and dark, 1440x900, saved to docs/screenshots and listed in its README.md.
 * Demo data is seeded through the admin API and by driving real chat requests through the
 * gateway against the mock upstream; no real keys are ever used. Needs DATABASE_URL (the
 * default matches docker-compose.dev.yml) to backdate demo history for the dashboard charts.
 */
const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const username = process.env.E2E_ADMIN_USERNAME ?? process.env.ADMIN_USERNAME ?? "";
const password = process.env.E2E_ADMIN_PASSWORD ?? process.env.ADMIN_PASSWORD ?? "";
const outputDir = path.resolve(process.cwd(), "docs/screenshots");
// Both are configurable so captures can run beside other instances: E2E_BASE_URL (default
// http://localhost:3000) and MOCK_UPSTREAM_PORT (default 4010).
const MOCK_PORT = Number(process.env.MOCK_UPSTREAM_PORT ?? 4010);
const databaseUrl =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgres://agentx:agentx@localhost:5432/agentx";
const MOCK_MJPEG_PORT = Number(process.env.MOCK_MJPEG_PORT ?? 4020);
const MOCK_VIDEO_PORT = Number(process.env.MOCK_VIDEO_PORT ?? 4030);
const MOCK_MCP_PORT = Number(process.env.MOCK_MCP_PORT ?? 4312);
const MOCK_WEBHOOK_PORT = Number(process.env.MOCK_WEBHOOK_PORT ?? 4513);
// Must match the SEARXNG_URL of the gateway under capture (the built-in web_search demo).
const MOCK_SEARXNG_PORT = Number(process.env.MOCK_SEARXNG_PORT ?? 4931);
// The one-time key shown in the "API key created" capture. Fixed so reruns are identical.
const DEMO_API_KEY = `agx_${"x".repeat(32)}`;
const themes = ["light", "dark"] as const;

interface Captured {
  file: string;
  caption: string;
}
const captured: Captured[] = [];

let upstream: MockUpstream;
let mcp: MockMcp;
let webhook: MockWebhook;
let searxng: MockSearxng;
let mediaSeed: MediaSeed;
let admin: APIRequestContext;
let gateway: APIRequestContext;
const demo = {
  reasoningSession: "",
  toolSession: "",
  mcpSession: "",
  searchSession: "",
  endedSession: "",
  failoverSession: "",
  responsesSession: "",
  agentFlow: "",
  agentSession: "",
  extrasFlow: "",
  subflow: "",
  callerFlow: "",
  versionFlow: "",
};

type Message = Record<string, unknown>;

const SYSTEM_PROMPT: Message = {
  role: "system",
  content:
    "You are Aiko, a friendly avatar who greets visitors in the lobby. Keep answers short and speak in plain sentences.",
};

/** Seeds providers, routes and a client key; returns the plaintext client key. */
async function seedDemoData(): Promise<string> {
  const existing = async (collection: string) =>
    ((await (await admin.get(`/api/admin/${collection}`)).json()).data ?? []) as Record<
      string,
      string
    >[];
  const providerIds: Record<string, string> = {};
  const demoProviders = [
    { name: "OpenAI", key: "sk-demo-openai-not-a-real-key-a1b2", responsesApi: false },
    { name: "DeepSeek", key: "sk-demo-deepseek-not-a-real-key-c3d4", responsesApi: false },
    { name: "Azure Responses", key: "sk-demo-azure-not-a-real-key-e5f6", responsesApi: true },
  ];
  for (const { name, key, responsesApi } of demoProviders) {
    const found = (await existing("providers")).find((provider) => provider.name === name);
    if (found) {
      providerIds[name] = found.id;
      continue;
    }
    const response = await admin.post("/api/admin/providers", {
      data: {
        name,
        base_url: upstream.url,
        api_key: key,
        capabilities: { streaming: true, tools: true, responses_api: responsesApi },
      },
    });
    expect(response.status()).toBe(201);
    providerIds[name] = (await response.json()).id;
  }

  // A demo MCP server whose tools are all allowed; the route selects two of them.
  let mcpToolIds: string[] = [];
  const mcpServers = (await existing("mcp-servers")) as { id: string; name: string }[];
  let mcpServer = mcpServers.find((server) => server.name === "Composio");
  if (!mcpServer) {
    const response = await admin.post("/api/admin/mcp-servers", {
      data: {
        name: "Composio",
        slug: "composio",
        url: mcp.url,
        transport: "streamable_http",
        headers: { "x-api-key": "sk-demo-composio-not-a-real-key" },
      },
    });
    expect(response.status()).toBe(201);
    mcpServer = (await response.json()) as { id: string; name: string };
  } else {
    const response = await admin.patch(`/api/admin/mcp-servers/${mcpServer.id}`, {
      data: { url: mcp.url },
    });
    expect(response.status()).toBe(200);
  }
  const refreshed = await admin.post(`/api/admin/mcp-servers/${mcpServer.id}/refresh-tools`);
  expect(refreshed.status()).toBe(200);
  const mcpTools = ((await refreshed.json()).data ?? []) as { id: string; name: string }[];
  for (const tool of mcpTools) {
    expect(
      (
        await admin.patch(`/api/admin/mcp-tools/${tool.id}`, {
          data: { allowed: true },
        })
      ).status(),
    ).toBe(200);
  }
  mcpToolIds = mcpTools
    .filter((tool) => tool.name === "echo" || tool.name === "add")
    .map((tool) => tool.id);

  const routes: {
    slug: string;
    description: string;
    steps: [string, string][];
    mcp?: boolean;
    builtin?: string[];
  }[] = [
    {
      slug: "avatar-default",
      description: "Default avatar conversation model with failover",
      steps: [
        ["OpenAI", "ok"],
        ["DeepSeek", "mock-model"],
      ],
      builtin: ["web_search", "read_web_page", "image_search"],
    },
    {
      slug: "avatar-reasoning",
      description: "Reasoning model (streams reasoning_content)",
      steps: [["OpenAI", "reasoning"]],
    },
    {
      slug: "avatar-thinking",
      description: "Model that thinks inside think tags",
      steps: [["DeepSeek", "think-tags"]],
    },
    {
      slug: "avatar-tools",
      description: "Model that calls the Unity show_image tool",
      steps: [["OpenAI", "tool-call"]],
    },
    {
      slug: "avatar-responses-native",
      description: "Responses API forwarded natively to a provider with responses_api",
      steps: [["Azure Responses", "echo"]],
    },
    {
      slug: "avatar-echo",
      description: "Echoes the user message",
      steps: [["OpenAI", "echo"]],
    },
    {
      slug: "avatar-failover",
      description: "Primary provider is down, the backup answers",
      steps: [
        ["OpenAI", "fail-503"],
        ["DeepSeek", "echo"],
      ],
    },
    {
      slug: "avatar-mcp",
      description: "Model that calls the allowed Composio echo and add MCP tools",
      steps: [["OpenAI", "mcp-multi"]],
      mcp: true,
    },
    {
      slug: "avatar-search",
      description: "Model that searches the web with the built-in web_search tool",
      steps: [["OpenAI", "gateway-tool"]],
      builtin: ["web_search"],
    },
  ];
  const existingRoutes = (await existing("routes")) as unknown as {
    id: string;
    slug: string;
    description: string;
    enabled: boolean;
    steps: { provider_id: string; upstream_model: string; timeout_ms: number }[];
  }[];
  for (const route of routes) {
    const stepPayload = route.steps.map(([provider, model], index) => ({
      provider_id: providerIds[provider],
      upstream_model: model,
      timeout_ms: index === 0 ? 20000 : 30000,
    }));
    const found = existingRoutes.find((entry) => entry.slug === route.slug);
    if (found) {
      if (!route.mcp && !route.builtin) continue;
      const response = await admin.put(`/api/admin/routes/${found.id}`, {
        data: {
          slug: found.slug,
          description: found.description,
          enabled: found.enabled,
          steps: found.steps,
          mcp_tool_ids: route.mcp ? mcpToolIds : [],
          builtin_tools: route.builtin ?? [],
        },
      });
      expect(response.status()).toBe(200);
      continue;
    }
    const response = await admin.post("/api/admin/routes", {
      data: {
        slug: route.slug,
        description: route.description,
        steps: stepPayload,
        ...(route.mcp ? { mcp_tool_ids: mcpToolIds } : {}),
        ...(route.builtin ? { builtin_tools: route.builtin } : {}),
      },
    });
    expect(response.status()).toBe(201);
  }

  // The plaintext key is only returned at creation, so the previous run's demo key was removed
  // by resetDemoSessions() and a single fresh one is created here.
  const response = await admin.post("/api/admin/api-keys", {
    data: {
      label: "Lobby kiosk",
      rpm_limit: 600,
      tokens_per_day_limit: 2000000,
    },
  });
  expect(response.status()).toBe(201);
  return (await response.json()).key as string;
}

/** Concatenated assistant text of an SSE chat response, with think tags removed. */
function replyText(sse: string): string {
  let text = "";
  for (const line of sse.split("\n")) {
    if (!line.startsWith("data: ") || line.includes("[DONE]")) continue;
    const delta = JSON.parse(line.slice(6)).choices?.[0]?.delta;
    if (typeof delta?.content === "string") text += delta.content;
  }
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

async function converse(model: string, messages: Message[], sessionId?: string) {
  const response = await gateway.post("/v1/chat/completions", {
    data: { model, stream: true, messages },
    headers: sessionId ? { "X-Session-Id": sessionId } : {},
  });
  expect(response.status()).toBe(200);
  const body = await response.text();
  return { id: response.headers()["x-session-id"] as string, reply: replyText(body) };
}

/** Concatenated `response.output_text.delta` text of a Responses SSE body. */
function responsesReplyText(sse: string): string {
  let text = "";
  for (const line of sse.split(/\r?\n/)) {
    if (!line.startsWith("data: ")) continue;
    const event = JSON.parse(line.slice(6));
    if (event.type === "response.output_text.delta") text += event.delta;
  }
  return text.trim();
}

async function converseResponses(model: string, input: Message[], sessionId?: string) {
  const response = await gateway.post("/v1/responses", {
    data: { model, stream: true, input, instructions: SYSTEM_PROMPT.content },
    headers: sessionId ? { "X-Session-Id": sessionId } : {},
  });
  expect(response.status()).toBe(200);
  const body = await response.text();
  return { id: response.headers()["x-session-id"] as string, reply: responsesReplyText(body) };
}

/**
 * Makes reruns idempotent: removes the sessions, request log and demo client key created by an
 * earlier capture so they are recreated exactly once. Providers and routes are reused by name.
 */
async function resetDemoSessions() {
  const database = postgres(databaseUrl, { max: 1 });
  try {
    await database`delete from llm_requests`;
    await database`delete from sessions`;
    await database`delete from api_keys where label in ('Lobby kiosk', 'Lobby kiosk (extra)')`;
    await database`delete from flows`;
    await database`delete from media_items`;
    await database`delete from cameras`;
  } finally {
    await database.end();
  }
}

/** Creates and publishes the demo agent (Start, Router intent, Webhook, Memory, LLM, Reply). */
async function seedAgentFlow(): Promise<string> {
  const created = await admin.post("/api/admin/flows", {
    data: {
      name: "Lobby greeter",
      slug: "lobby-greeter",
      description: "Checks the lobby status through a webhook, remembers it and answers as Aiko.",
      enabled: true,
      settings: { default_route_slug: "avatar-echo" },
    },
  });
  expect(created.status()).toBe(201);
  const flow = (await created.json()) as { id: string };
  const start = {
    id: "start",
    type: "start",
    position: { x: 300, y: 0 },
    data: { title: "Start" },
  };
  const router = {
    id: "router",
    type: "router",
    position: { x: 300, y: 120 },
    data: {
      title: "Which request?",
      mode: "intent",
      model: "avatar-echo",
      intentLabels: ["smalltalk"],
      intentInstruction: "Pick smalltalk for greetings, otherwise answer with the default.",
      defaultLabel: "info",
      rules: [],
    },
  };
  const webhookNode = {
    id: "hook",
    type: "webhook",
    position: { x: 300, y: 260 },
    data: {
      title: "Check lobby status",
      method: "GET",
      url: `http://127.0.0.1:${MOCK_WEBHOOK_PORT}/hook`,
      headers: [],
      bodyTemplate: "",
      timeoutMs: 5000,
      retries: 1,
      maxResponseBytes: 65536,
      mappings: [{ variable: "hook_value", path: "data.value" }],
      outputVariable: "hook_payload",
    },
  };
  const memory = {
    id: "remember_memory",
    type: "memory",
    position: { x: 300, y: 380 },
    data: {
      title: "Remember status",
      operation: "set",
      key: "last_hook",
      value: "{{vars.hook_value}}",
      outputVariable: "saved",
    },
  };
  const llm = {
    id: "llm",
    type: "llm",
    position: { x: 300, y: 500 },
    data: {
      title: "Write the answer",
      model: "inherit",
      systemPrompt: "You are Aiko, a friendly lobby greeter. Keep the answer to one sentence.",
      history: "full",
      historyLimit: 10,
      mcpToolIds: [],
      outputVariable: "llm_output",
      stream: true,
    },
  };
  const reply = {
    id: "reply",
    type: "reply",
    position: { x: 300, y: 620 },
    data: {
      title: "Lobby answer",
      template: "Aiko checked the lobby: {{vars.hook_value}}. {{vars.llm_output}}",
    },
  };
  const smalltalk = {
    id: "smalltalk",
    type: "reply",
    position: { x: 40, y: 260 },
    data: { title: "Greeting", template: "Hi there! Ask me about the lobby." },
  };
  const end = { id: "end", type: "end", position: { x: 300, y: 740 }, data: { title: "End" } };
  const graph = {
    nodes: [start, router, webhookNode, memory, llm, reply, smalltalk, end],
    edges: [
      { id: "e1", source: "start", target: "router", sourceHandle: "out", type: "smoothstep" },
      {
        id: "e2",
        source: "router",
        target: "smalltalk",
        sourceHandle: "intent:smalltalk",
        type: "smoothstep",
      },
      { id: "e3", source: "router", target: "hook", sourceHandle: "default", type: "smoothstep" },
      {
        id: "e4",
        source: "hook",
        target: "remember_memory",
        sourceHandle: "out",
        type: "smoothstep",
      },
      { id: "e5", source: "hook", target: "llm", sourceHandle: "error", type: "smoothstep" },
      {
        id: "e6",
        source: "remember_memory",
        target: "llm",
        sourceHandle: "out",
        type: "smoothstep",
      },
      { id: "e7", source: "llm", target: "reply", sourceHandle: "out", type: "smoothstep" },
      { id: "e8", source: "reply", target: "end", sourceHandle: "out", type: "smoothstep" },
      { id: "e9", source: "smalltalk", target: "end", sourceHandle: "out", type: "smoothstep" },
    ],
  };
  // Dagre lays the demo out top-to-bottom with generous separation so smoothstep edges route
  // between cards instead of cutting across them.
  const layout = new dagre.graphlib.Graph();
  layout.setDefaultEdgeLabel(() => ({}));
  layout.setGraph({ rankdir: "TB", nodesep: 70, ranksep: 110, marginx: 40, marginy: 40 });
  for (const node of graph.nodes) layout.setNode(node.id, { width: 232, height: 104 });
  for (const edge of graph.edges) layout.setEdge(edge.source, edge.target);
  dagre.layout(layout);
  for (const node of graph.nodes) {
    const placed = layout.node(node.id);
    node.position = { x: Math.round(placed.x - 116), y: Math.round(placed.y - 52) };
  }
  const drafted = await admin.put(`/api/admin/flows/${flow.id}/draft`, { data: { graph } });
  expect(drafted.status()).toBe(200);
  const published = await admin.post(`/api/admin/flows/${flow.id}/publish`, {
    data: { note: "Demo agent" },
  });
  expect(published.status()).toBe(201);
  return flow.id;
}
async function createDemoFlow(data: Record<string, unknown>): Promise<string> {
  const response = await admin.post("/api/admin/flows", { data });
  expect(response.status()).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

/**
 * Seeds the G7b editor extras: a Client Action + sticky note + group + comment, a published
 * subflow, a caller pinned to its first version (so the "update available" badge shows) and a
 * flow with a published version plus a changed draft for the version compare view.
 */
async function seedG7bFlows() {
  const media = (await (await admin.get("/api/admin/media")).json()).data as {
    id: string;
    name: string;
  }[];
  const mediaId = media.find((entry) => entry.name === "Sunset")?.id ?? media[0]?.id;
  expect(mediaId).toBeTruthy();

  // --- extras agent: Client Action, sticky note, group and a node comment ---------------------
  const extras = await createDemoFlow({
    name: "Lobby extras demo",
    slug: "lobby-extras-demo",
    description: "Shows a picture with a Client Action, with an editor note and a visual group.",
    enabled: false,
  });
  const extrasGraph = {
    nodes: [
      {
        id: "start",
        type: "start",
        position: { x: 0, y: 0 },
        data: {
          title: "Start",
          comment: "Greets visitors at the front desk.",
          commentUpdatedAt: "2026-11-01T09:15:00.000Z",
        },
      },
      {
        id: "show_photo",
        type: "client_action",
        position: { x: 0, y: 160 },
        data: {
          title: "Show the lobby picture",
          toolName: "show_image",
          argsTemplate: `{\n  "media_id": "${mediaId}"\n}`,
          outputVariable: "client_result",
        },
      },
      {
        id: "group_replies",
        type: "group",
        position: { x: 0, y: 320 },
        width: 300,
        height: 180,
        zIndex: -1,
        data: { title: "Front desk replies", color: "blue", collapsed: false },
      },
      {
        id: "reply",
        type: "reply",
        parentId: "group_replies",
        position: { x: 30, y: 40 },
        data: {
          title: "Aiko's reply",
          template: "Here is the lobby picture you asked for.",
        },
      },
      { id: "end", type: "end", position: { x: 0, y: 540 }, data: { title: "End" } },
      {
        id: "note_1",
        type: "note",
        position: { x: 360, y: 160 },
        width: 280,
        height: 200,
        zIndex: 1,
        data: {
          title: "Editor note",
          markdown:
            "**Canvas-only helpers**\n\n- Sticky notes hold Markdown\n- Groups move their children\n- Comments open from the speech bubble",
          color: "yellow",
        },
      },
    ],
    edges: [
      { id: "e1", source: "start", target: "show_photo", sourceHandle: "out", type: "smoothstep" },
      { id: "e2", source: "show_photo", target: "reply", sourceHandle: "out", type: "smoothstep" },
      { id: "e3", source: "reply", target: "end", sourceHandle: "out", type: "smoothstep" },
    ],
  };
  expect(
    (
      await admin.put(`/api/admin/flows/${extras}/draft`, { data: { graph: extrasGraph } })
    ).status(),
  ).toBe(200);
  demo.extrasFlow = extras;

  // --- subflow: one input, one output ----------------------------------------------------------
  const subflow = await createDemoFlow({
    name: "Lobby topic lookup",
    slug: "lobby-topic-lookup",
    description: "Answers a visitor question about a lobby topic.",
    kind: "subflow",
    enabled: true,
  });
  const subflowGraph = {
    nodes: [
      {
        id: "in",
        type: "subflow_input",
        position: { x: 0, y: 0 },
        data: { title: "Input", params: [{ name: "topic", type: "string", required: true }] },
      },
      {
        id: "say",
        type: "reply",
        position: { x: 300, y: 0 },
        data: { title: "Topic answer", template: "You asked about {{vars.topic}}." },
      },
      {
        id: "out",
        type: "subflow_output",
        position: { x: 600, y: 0 },
        data: {
          title: "Answer",
          label: "answer",
          values: [{ name: "summary", value: "{{nodes.say.output}}" }],
        },
      },
    ],
    edges: [
      { id: "e1", source: "in", target: "say", sourceHandle: "out", type: "smoothstep" },
      { id: "e2", source: "say", target: "out", sourceHandle: "out", type: "smoothstep" },
    ],
  };
  expect(
    (
      await admin.put(`/api/admin/flows/${subflow}/draft`, { data: { graph: subflowGraph } })
    ).status(),
  ).toBe(200);
  expect(
    (
      await admin.post(`/api/admin/flows/${subflow}/publish`, { data: { note: "Demo subflow v1" } })
    ).status(),
  ).toBe(201);
  demo.subflow = subflow;

  // --- caller pinned to subflow v1, then the subflow moves to v2 -------------------------------
  const caller = await createDemoFlow({
    name: "Lobby subflow caller",
    slug: "lobby-subflow-caller",
    description: "Calls the topic lookup subflow and answers with its result.",
    enabled: false,
  });
  const callerGraph = {
    nodes: [
      { id: "start", type: "start", position: { x: 0, y: 0 }, data: { title: "Start" } },
      {
        id: "call",
        type: "call_subflow",
        position: { x: 0, y: 160 },
        data: {
          title: "Look up the topic",
          subflowId: subflow,
          subflowName: "Lobby topic lookup",
          inputs: [{ name: "topic", value: "{{input.text}}" }],
          outputs: [{ label: "answer", variable: "topic_answer" }],
        },
      },
      {
        id: "reply",
        type: "reply",
        position: { x: 0, y: 320 },
        data: { title: "Answer the visitor", template: "{{vars.topic_answer}}" },
      },
      { id: "end", type: "end", position: { x: 0, y: 480 }, data: { title: "End" } },
    ],
    edges: [
      { id: "e1", source: "start", target: "call", sourceHandle: "out", type: "smoothstep" },
      {
        id: "e2",
        source: "call",
        target: "reply",
        sourceHandle: "out:answer",
        type: "smoothstep",
      },
      { id: "e3", source: "reply", target: "end", sourceHandle: "out", type: "smoothstep" },
    ],
  };
  expect(
    (
      await admin.put(`/api/admin/flows/${caller}/draft`, { data: { graph: callerGraph } })
    ).status(),
  ).toBe(200);
  expect(
    (
      await admin.post(`/api/admin/flows/${caller}/publish`, { data: { note: "Pins v1" } })
    ).status(),
  ).toBe(201);
  demo.callerFlow = caller;
  // A newer published subflow version makes the caller's Call Subflow node show "Update v1 -> v2".
  expect(
    (
      await admin.post(`/api/admin/flows/${subflow}/publish`, { data: { note: "Demo subflow v2" } })
    ).status(),
  ).toBe(201);

  // --- version compare: a published v1 and a changed draft -------------------------------------
  const version = await createDemoFlow({
    name: "Lobby version compare",
    slug: "lobby-version-compare",
    description: "A published flow whose draft has since changed.",
    enabled: false,
  });
  const starter = {
    nodes: [
      { id: "start", type: "start", position: { x: 0, y: 0 }, data: { title: "Start" } },
      {
        id: "reply",
        type: "reply",
        position: { x: 260, y: 0 },
        data: { title: "Greeting", template: "Hi! How can I help?" },
      },
      { id: "end", type: "end", position: { x: 520, y: 0 }, data: { title: "End" } },
    ],
    edges: [
      { id: "e1", source: "start", target: "reply", sourceHandle: "out", type: "smoothstep" },
      { id: "e2", source: "reply", target: "end", sourceHandle: "out", type: "smoothstep" },
    ],
  };
  expect(
    (await admin.put(`/api/admin/flows/${version}/draft`, { data: { graph: starter } })).status(),
  ).toBe(200);
  expect(
    (
      await admin.post(`/api/admin/flows/${version}/publish`, { data: { note: "Before edits" } })
    ).status(),
  ).toBe(201);
  const changed = {
    nodes: [
      starter.nodes[0],
      {
        ...starter.nodes[1],
        data: { title: "Greeting", template: "Hi there! Ask me about the lobby." },
      },
      starter.nodes[2],
      {
        id: "note_diff",
        type: "note",
        position: { x: 0, y: 180 },
        width: 260,
        height: 140,
        zIndex: 1,
        data: { title: "New note", markdown: "Added after publishing.", color: "green" },
      },
    ],
    edges: starter.edges,
  };
  expect(
    (await admin.put(`/api/admin/flows/${version}/draft`, { data: { graph: changed } })).status(),
  ).toBe(200);
  demo.versionFlow = version;
}

/** Seeds sessions by sending real requests, then backdates demo history for the charts. */
async function seedSessions() {
  const database = postgres(databaseUrl, { max: 2 });
  const waitForRequests = async (sessionId: string, count: number) => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const [row] =
        await database`select count(*)::int as n from llm_requests where session_id = ${sessionId}`;
      if (row.n >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("transcript was not persisted");
  };

  try {
    // 1. Multi-turn conversation: reasoning_content, think tags, then Markdown.
    const history: Message[] = [SYSTEM_PROMPT];
    let sessionId: string | undefined;
    const turns: [string, string][] = [
      ["avatar-reasoning", "Hello! Who are you and what can you do?"],
      ["avatar-thinking", "Can you plan a short tour of the lobby for me?"],
      [
        "avatar-echo",
        "Summarise it as a **checklist**:\n\n- Reception desk\n- Coffee corner\n- Art wall",
      ],
    ];
    let requestCount = 0;
    for (const [route, text] of turns) {
      history.push({ role: "user", content: text });
      const result = await converse(route, [...history], sessionId);
      sessionId = result.id;
      history.push({ role: "assistant", content: result.reply });
      requestCount += 1;
      await waitForRequests(sessionId, requestCount);
    }
    demo.reasoningSession = sessionId as string;

    // 2. Client tool round: the model calls show_image, the client answers, the model finishes.
    const toolHistory: Message[] = [
      SYSTEM_PROMPT,
      { role: "user", content: "Show me a sunset photo, please." },
    ];
    const toolFirst = await converse("avatar-tools", [...toolHistory]);
    await waitForRequests(toolFirst.id, 1);
    // Let the call-to-result duration be visible in the card.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    toolHistory.push(
      {
        role: "assistant",
        content: "Let me show that.",
        tool_calls: [
          {
            id: "call_mock_1",
            type: "function",
            function: { name: "show_image", arguments: '{"media_id":"sunset"}' },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_mock_1",
        content: '{"shown":true,"media_id":"sunset"}',
      },
    );
    const toolSecond = await converse("avatar-tools", [...toolHistory], toolFirst.id);
    await waitForRequests(toolFirst.id, 2);
    toolHistory.push(
      { role: "assistant", content: toolSecond.reply },
      { role: "user", content: "Thanks, that is lovely." },
    );
    await converse("avatar-echo", [...toolHistory], toolFirst.id);
    await waitForRequests(toolFirst.id, 3);
    demo.toolSession = toolFirst.id;

    // 2b. MCP tool loop: the gateway calls two MCP tools and answers in one client request.
    const mcpResult = await converse("avatar-mcp", [
      SYSTEM_PROMPT,
      { role: "user", content: "Echo one, then add four and five." },
    ]);
    await waitForRequests(mcpResult.id, 1);
    demo.mcpSession = mcpResult.id;

    // 2c. Built-in tool: the gateway runs web_search itself (mock SearXNG) and answers.
    const searchResult = await converse("avatar-search", [
      SYSTEM_PROMPT,
      {
        role: "user",
        content: JSON.stringify({ tool: "web_search", args: { query: "red panda" } }),
      },
    ]);
    await waitForRequests(searchResult.id, 1);
    demo.searchSession = searchResult.id;

    // 3. Ended by an admin after two turns.
    const endedHistory: Message[] = [
      SYSTEM_PROMPT,
      { role: "user", content: "What are your opening hours?" },
    ];
    const ended = await converse("avatar-echo", [...endedHistory]);
    await waitForRequests(ended.id, 1);
    endedHistory.push(
      { role: "assistant", content: ended.reply },
      { role: "user", content: "And on weekends?" },
    );
    await converse("avatar-echo", [...endedHistory], ended.id);
    await waitForRequests(ended.id, 2);
    expect((await admin.post(`/api/admin/sessions/${ended.id}/end`)).status()).toBe(200);
    demo.endedSession = ended.id;

    // 4. Failover: the primary provider is down, the backup answers.
    const failover = await converse("avatar-failover", [
      SYSTEM_PROMPT,
      { role: "user", content: "Is the cafe open right now?" },
    ]);
    await waitForRequests(failover.id, 1);
    demo.failoverSession = failover.id;

    // 4b. Responses API client: a translated turn (responses -> chat) with reasoning, then a
    // native turn (responses -> responses) in the same session.
    const responsesInput: Message[] = [
      { role: "user", content: "Hello! Please greet our visitors." },
    ];
    const responsesFirst = await converseResponses("avatar-reasoning", [...responsesInput]);
    await waitForRequests(responsesFirst.id, 1);
    responsesInput.push(
      { role: "assistant", content: responsesFirst.reply },
      { role: "user", content: "Now say it once more, natively." },
    );
    await converseResponses("avatar-responses-native", [...responsesInput], responsesFirst.id);
    await waitForRequests(responsesFirst.id, 2);
    demo.responsesSession = responsesFirst.id;

    // 4c. Agent run: Start, Router intent, Webhook, Memory, LLM and Reply.
    const agent = await gateway.post("/v1/chat/completions", {
      data: {
        agent_id: demo.agentFlow,
        stream: true,
        messages: [
          SYSTEM_PROMPT,
          { role: "user", content: "Hello, can you check the lobby status?" },
        ],
      },
    });
    expect(agent.status()).toBe(200);
    await agent.text();
    demo.agentSession = agent.headers()["x-session-id"] as string;
    await waitForRequests(demo.agentSession, 1);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const [row] =
        await database`select count(*)::int as n from run_logs where session_id = ${demo.agentSession}`;
      if (row.n > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // 5. Standalone one-shot helper call (idle-expired and flagged by the sweeper).
    const oneShot = await converse("avatar-echo", [
      { role: "user", content: "Write a three word title for this conversation." },
    ]);
    await waitForRequests(oneShot.id, 1);
    await database`update sessions set last_activity_at = now() - interval '45 minutes' where id = ${oneShot.id}`;

    // 6. Demo history over the last two weeks for the dashboard charts (hidden: standalone).
    const historyRoutes = ["avatar-echo", "avatar-echo", "avatar-failover"];
    for (let index = 0; index < 18; index += 1) {
      const result = await converse(historyRoutes[index % historyRoutes.length], [
        { role: "user", content: `History request ${index + 1}` },
      ]);
      await waitForRequests(result.id, 1);
      const days = 1 + ((index * 5) % 13);
      await database`update sessions set started_at = now() - make_interval(days => ${days}), last_activity_at = now() - make_interval(days => ${days}) where id = ${result.id}`;
      await database`update turns set started_at = now() - make_interval(days => ${days}) where session_id = ${result.id}`;
      await database`update llm_requests set started_at = now() - make_interval(days => ${days}) where session_id = ${result.id}`;
    }

    // Expire and flag the backdated sessions now instead of waiting for the sweeper.
    expect((await admin.post("/api/admin/sessions/maintenance")).status()).toBe(200);
  } finally {
    await database.end();
  }
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

test.beforeAll(async () => {
  mkdirSync(outputDir, { recursive: true });
  upstream = await startMockUpstream({
    port: MOCK_PORT,
    models: ["ok", "mock-model", "gpt-demo", "gateway-tool"],
  });
  mcp = await startMockMcp({ port: MOCK_MCP_PORT, slowMs: 500 });
  webhook = await startMockWebhook({ port: MOCK_WEBHOOK_PORT });
  searxng = await startMockSearxng({ port: MOCK_SEARXNG_PORT });
  admin = await playwrightRequest.newContext({
    baseURL,
    httpCredentials: { username, password },
  });
  await resetDemoSessions();
  const clientKey = await seedDemoData();
  gateway = await playwrightRequest.newContext({
    baseURL,
    extraHTTPHeaders: { Authorization: `Bearer ${clientKey}` },
  });
  demo.agentFlow = await seedAgentFlow();
  mediaSeed = await seedMediaAndCameras(admin, { mjpeg: MOCK_MJPEG_PORT, video: MOCK_VIDEO_PORT });
  await seedG7bFlows();
  await seedSessions();
});

test.afterAll(async () => {
  await admin.dispose();
  await gateway.dispose();
  await upstream.close();
  await mcp.close();
  await webhook.close();
  await searxng.close();
  await mediaSeed.close();
  const lines = [
    "# CRM screenshots",
    "",
    "Generated by `pnpm screenshots` (see `playwright.screenshots.config.ts`). Do not edit by hand:",
    "rerun the command to regenerate. 1440x900, light and dark theme, seeded with demo data.",
    "",
    "| Image | Caption |",
    "|---|---|",
    ...captured.map((entry) => `| ![${entry.file}](${entry.file}) | ${entry.caption} |`),
    "",
  ];
  writeFileSync(path.join(outputDir, "README.md"), lines.join("\n"));
});

for (const theme of themes) {
  test.describe(`${theme} theme`, () => {
    test.use({
      colorScheme: theme,
      httpCredentials: { username, password },
      viewport: { width: 1440, height: 900 },
    });

    test.beforeEach(async ({ page }) => {
      await page.addInitScript((value) => {
        window.localStorage.setItem("theme", value);
      }, theme);
    });

    /** Waits for network, fonts, open dialogs and animations so captures never show mid-transition frames. */
    async function settle(page: import("@playwright/test").Page) {
      await page.waitForLoadState("networkidle");
      await page.addStyleTag({
        content:
          "*, *::before, *::after { animation: none !important; transition: none !important; }",
      });
      await page.evaluate(() => document.fonts.ready);
      // Charts animate in; wait for them to finish before capturing.
      await page.waitForTimeout(800);
    }

    /**
     * Fits the flow before settling. Fit before the animation-disabling CSS goes in: React Flow
     * applies the viewport through a transition, so disabling transitions first makes fit a no-op.
     */
    async function settleCanvas(page: import("@playwright/test").Page) {
      await page.waitForLoadState("networkidle");
      await page.getByTestId("rf__controls").getByRole("button", { name: "Fit View" }).click();
      await page.waitForTimeout(400);
      await settle(page);
    }

    /** Dialogs must be fully open and no closing dialog or overlay may remain stacked behind. */
    async function settleDialog(page: import("@playwright/test").Page, expectedOpen = 1) {
      const open = page.locator(
        '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]',
      );
      await expect(open).toHaveCount(expectedOpen);
      await expect(page.locator('[data-slot$="overlay"][data-state="closed"]')).toHaveCount(0);
      await expect(page.locator('[role="dialog"][data-state="closed"]')).toHaveCount(0);
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
    }

    async function save(
      page: import("@playwright/test").Page,
      name: string,
      caption: string,
      fullPage: boolean,
      keepScroll = false,
    ) {
      const file = `${name}-${theme}.png`;
      // Captures start at the top unless a state deliberately scrolls to its subject.
      if (!keepScroll) await page.evaluate(() => window.scrollTo(0, 0));
      if (fullPage) {
        // The sidebar is `position: fixed` and as tall as the viewport, so a native fullPage
        // capture leaves it short. Grow the viewport to the document height instead, which is
        // what a tall monitor would show.
        const height = await page.evaluate(() => document.documentElement.scrollHeight);
        const original = page.viewportSize();
        await page.setViewportSize({ width: original?.width ?? 1440, height });
        await page.evaluate(
          () =>
            new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        );
        await page.waitForTimeout(300);
        await page.screenshot({ path: path.join(outputDir, file) });
        if (original) await page.setViewportSize(original);
      } else {
        await page.screenshot({ path: path.join(outputDir, file) });
      }
      captured.push({ file, caption: `${caption} (${theme} theme)` });
    }

    async function waitForMediaLoaded(page: import("@playwright/test").Page) {
      await expect(page.getByTestId("media-card").first()).toBeVisible();
      await page.waitForFunction(
        () =>
          [...document.querySelectorAll("img")].every(
            (img) => img.complete && img.naturalWidth > 0,
          ) && [...document.querySelectorAll("video")].every((video) => video.readyState >= 2),
      );
      await page.waitForTimeout(300);
    }

    for (const group of navGroups) {
      for (const navPage of group.pages) {
        test(`page ${group.id} / ${navPage.title}`, async ({ page }) => {
          await page.goto(navPage.href);
          await expect(page.getByRole("heading", { name: navPage.title, level: 1 })).toBeVisible();
          if (navPage.href === "/sessions") {
            await expect(page.getByRole("link", { name: /UTC$/ }).first()).toBeVisible();
          }
          await settle(page);
          if (navPage.href === "/media") await waitForMediaLoaded(page);
          await save(
            page,
            `${group.id}-${slugify(navPage.title)}`,
            `${group.title} / ${navPage.title}: ${navPage.description}`,
            true,
          );
        });
      }
    }

    test("state: provider create dialog", async ({ page }) => {
      await page.goto("/providers");
      await settle(page);
      await page.getByRole("button", { name: "New provider" }).click();
      await page.getByLabel("Name").fill("Groq");
      await page.getByLabel("Base URL").fill("https://api.groq.com/openai/v1");
      await page.getByLabel("Responses API").scrollIntoViewIfNeeded();
      await settleDialog(page);
      await save(
        page,
        "state-provider-dialog",
        "Providers: create dialog (the key field is write-only)",
        false,
      );
    });

    test("state: provider test connection result", async ({ page }) => {
      await page.goto("/providers");
      await settle(page);
      await page
        .getByRole("row", { name: /OpenAI/ })
        .getByRole("button", { name: "Test connection" })
        .click();
      await expect(page.getByRole("heading", { name: "Connection succeeded" })).toBeVisible();
      await settleDialog(page);
      // Latency varies per run; pin it so regenerated images stay stable.
      await page.evaluate(() => {
        for (const node of document.querySelectorAll("dd")) {
          if (/^\d+ ms$/.test(node.textContent ?? "")) node.textContent = "12 ms";
        }
      });
      await save(
        page,
        "state-provider-test-result",
        "Providers: test connection result with latency and model count",
        false,
      );
    });

    test("state: route editor with two steps", async ({ page }) => {
      await page.goto("/routes");
      await settle(page);
      await page.getByRole("button", { name: "Edit avatar-default" }).click();
      await expect(page.getByRole("button", { name: "Move step 2 up" })).toBeVisible();
      await settleDialog(page);
      await save(
        page,
        "state-route-editor",
        "Model Routes: editor with two ordered failover steps (drag handle and arrow buttons)",
        false,
      );
    });

    test("state: route editor built-in tools", async ({ page }) => {
      await page.goto("/routes");
      await settle(page);
      await page.getByRole("button", { name: "Edit avatar-default" }).click();
      const heading = page.getByRole("heading", { name: "Built-in tools" });
      await expect(heading).toBeVisible();
      await settleDialog(page);
      await heading.scrollIntoViewIfNeeded();
      await save(
        page,
        "state-route-editor-builtin-tools",
        "Model Routes: the Built-in tools section with one checkbox per gateway tool (web_search, read_web_page and image_search ticked; video_search needs yt-dlp)",
        false,
        true,
      );
    });

    test("state: API reference", async ({ page }) => {
      await page.goto("/docs");
      await page.waitForLoadState("networkidle");
      const operation = page.getByRole("heading", { name: "Create a chat completion" });
      await operation.scrollIntoViewIfNeeded();
      await expect(operation).toBeInViewport();
      await page.waitForTimeout(500);
      await save(
        page,
        "state-api-reference",
        "API reference (/docs): the chat completions operation from GET /v1/openapi.json, behind the admin sign-in",
        false,
        true,
      );
    });

    test("state: chatflow editor canvas", async ({ page }) => {
      await page.goto(`/chatflows/${demo.agentFlow}`);
      await expect(page.getByRole("heading", { name: "Lobby greeter", level: 1 })).toBeVisible();
      await expect(page.getByTestId("flow-node-llm")).toBeVisible();
      await settleCanvas(page);
      await save(
        page,
        "state-chatflow-editor",
        "Chatflow editor: palette, dotted canvas with dynamic Router and error handles, minimap and auto-layout",
        false,
      );
    });

    test("state: chatflow properties panel", async ({ page }) => {
      await page.goto(`/chatflows/${demo.agentFlow}`);
      await expect(page.getByTestId("flow-node-router")).toBeVisible();
      await page.locator('[data-node-type="router"]').click({ position: { x: 12, y: 12 } });
      await expect(page.getByText("Intent labels")).toBeVisible();
      await settleCanvas(page);
      await save(
        page,
        "state-chatflow-properties",
        "Chatflow editor: properties panel generated from the node schemas (intent labels, route picker, templates)",
        false,
      );
    });

    test("state: chatflow publish dialog", async ({ page }) => {
      await page.goto(`/chatflows/${demo.agentFlow}`);
      await settleCanvas(page);
      await page.getByRole("button", { name: "Publish", exact: true }).click();
      await expect(page.getByText("Validation passed.")).toBeVisible();
      await settleDialog(page);
      await save(
        page,
        "state-chatflow-publish",
        "Chatflow editor: publish dialog with validation results and a version note",
        false,
      );
      await page.keyboard.press("Escape");
    });

    test("state: chatflow version history", async ({ page }) => {
      await page.goto(`/chatflows/${demo.agentFlow}`);
      await settleCanvas(page);
      await page.getByRole("button", { name: "Versions", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Version history" })).toBeVisible();
      await page.getByRole("button", { name: "View version 1" }).click();
      await settleDialog(page);
      await save(
        page,
        "state-chatflow-versions",
        "Chatflow editor: version history with a published version preview and restore",
        false,
      );
      await page.keyboard.press("Escape");
    });

    test("state: chatflow test drawer with trace", async ({ page }) => {
      await page.goto(`/chatflows/${demo.agentFlow}`);
      await settleCanvas(page);
      await page.getByRole("button", { name: "Open test drawer" }).click();
      await page
        .getByRole("textbox", { name: "Test message" })
        .fill("Hello, can you check the lobby status?");
      await page.getByRole("button", { name: "Run test message" }).click();
      await page.getByRole("button", { name: "Trace" }).last().click();
      await expect(page.getByTestId("test-trace")).toContainText("Lobby answer", {
        timeout: 30_000,
      });
      await expect(page.getByTestId("test-trace")).toContainText("Check lobby status");
      await settle(page);
      await save(
        page,
        "state-chatflow-test-trace",
        "Chatflow editor: test drawer running the draft with the per-node trace (click a step to highlight its node)",
        false,
      );
      await page.getByRole("button", { name: "Close test drawer" }).click();
    });

    test("state: chatflow Client Action properties", async ({ page }) => {
      await page.goto(`/chatflows/${demo.extrasFlow}`);
      await expect(page.getByTestId("flow-node-show_photo")).toBeVisible();
      await page.locator('[data-node-type="client_action"]').click({ position: { x: 12, y: 12 } });
      await expect(page.getByLabel("Client tool")).toBeVisible();
      await expect(page.getByLabel("Media item")).toBeVisible();
      await settleCanvas(page);
      await save(
        page,
        "state-chatflow-client-action",
        "Chatflow editor: a Client Action node with its inspector (tool, media picker and JSON arguments template)",
        false,
      );
    });

    test("state: chatflow sticky notes and group", async ({ page }) => {
      await page.goto(`/chatflows/${demo.extrasFlow}`);
      await expect(page.locator('[data-node-type="note"]')).toBeVisible();
      await expect(page.locator('[data-node-type="group"]')).toBeVisible();
      await settleCanvas(page);
      await save(
        page,
        "state-chatflow-notes-group",
        "Chatflow editor: a sticky note and a visual group frame, both canvas-only and never executed",
        false,
      );
    });

    test("state: chatflow comment popover", async ({ page }) => {
      await page.goto(`/chatflows/${demo.extrasFlow}`);
      await expect(page.getByTestId("flow-node-start")).toBeVisible();
      await settleCanvas(page);
      // Dispatch the click: the node can sit under the canvas overlay when the graph is small.
      await page
        .getByRole("button", { name: "Show comment" })
        .first()
        .evaluate((element) => (element as HTMLElement).click());
      await expect(page.getByText(/Last edited/)).toBeVisible();
      await save(
        page,
        "state-chatflow-comment",
        "Chatflow editor: the node comment popover with the last-edited time",
        false,
      );
      await page.keyboard.press("Escape");
    });

    test("state: chatflow subflow editor", async ({ page }) => {
      await page.goto(`/chatflows/${demo.subflow}`);
      await expect(
        page.getByRole("heading", { name: "Lobby topic lookup", level: 1 }),
      ).toBeVisible();
      await expect(page.getByTestId("flow-node-in")).toBeVisible();
      await expect(page.getByTestId("flow-node-out")).toBeVisible();
      await settleCanvas(page);
      await save(
        page,
        "state-chatflow-subflow",
        "Subflow editor: Subflow Input parameters, the flow body and a labelled Subflow Output",
        false,
      );
    });

    test("state: chatflow Call Subflow update badge", async ({ page }) => {
      await page.goto(`/chatflows/${demo.callerFlow}`);
      await expect(page.getByTestId("flow-node-call")).toBeVisible();
      await expect(page.getByTestId("node-badge")).toContainText("Update v1 → v2");
      await settleCanvas(page);
      await save(
        page,
        "state-chatflow-call-subflow",
        'Chatflow editor: a Call Subflow node pinned to v1 with the "Update available" badge after v2 was published',
        false,
      );
    });

    test("state: chatflow version compare", async ({ page }) => {
      await page.goto(`/chatflows/${demo.versionFlow}`);
      await expect(
        page.getByRole("heading", { name: "Lobby version compare", level: 1 }),
      ).toBeVisible();
      await settleCanvas(page);
      await page.getByRole("button", { name: "Versions", exact: true }).click();
      await page.getByRole("button", { name: "View version 1" }).click();
      await page.getByRole("button", { name: "Compare with draft" }).click();
      await expect(page.getByTestId("version-diff")).toBeVisible();
      await expect(page.getByText("Added nodes")).toBeVisible();
      await settleDialog(page);
      await save(
        page,
        "state-chatflow-version-compare",
        "Chatflow editor: version compare highlighting added and changed nodes between a published version and the draft",
        false,
      );
      await page.keyboard.press("Escape");
    });

    test("state: chatflow import with re-link", async ({ page }) => {
      const payload = {
        format: "agentx.chatflow",
        format_version: 1,
        flow: {
          name: "Imported lobby flow",
          kind: "agent",
          description: "Imported from JSON; webhook headers need re-linking.",
          settings: { default_route_slug: null, allowed_media_tags: [], allowed_cameras: [] },
        },
        graph: {
          nodes: [
            { id: "start", type: "start", position: { x: 0, y: 0 }, data: { title: "Start" } },
            {
              id: "hook",
              type: "webhook",
              position: { x: 260, y: 0 },
              data: {
                title: "Notify the desk",
                method: "POST",
                url: "https://lobby.internal/notify",
                headers: [{ name: "X-Api-Key" }],
                bodyTemplate: "",
                timeoutMs: 10_000,
                retries: 0,
                maxResponseBytes: 65_536,
                mappings: [],
                outputVariable: "hook",
              },
            },
            { id: "end", type: "end", position: { x: 520, y: 0 }, data: { title: "End" } },
          ],
          edges: [
            { id: "e1", source: "start", target: "hook", sourceHandle: "out" },
            { id: "e2", source: "hook", target: "end", sourceHandle: "out" },
          ],
        },
      };
      await page.goto("/chatflows");
      await settle(page);
      await page.getByRole("button", { name: "Import JSON" }).click();
      await page.getByLabel("Imported chatflow JSON").fill(JSON.stringify(payload));
      await page.getByRole("button", { name: "Import chatflow" }).click();
      await expect(page.getByText("Re-link these webhook headers:")).toBeVisible();
      await expect(page.getByLabel("Webhook headers to re-link")).toContainText("X-Api-Key");
      await settleDialog(page);
      await save(
        page,
        "state-chatflow-import",
        "Chatflows: the JSON import dialog listing the webhook headers that must be re-linked",
        false,
      );
      await page.keyboard.press("Escape");
    });

    test("state: chatflow paused for client trace", async ({ page }) => {
      await page.goto(`/chatflows/${demo.extrasFlow}`);
      await settleCanvas(page);
      await page.getByRole("button", { name: "Open test drawer" }).click();
      await page.getByRole("textbox", { name: "Test message" }).fill("Show me the lobby.");
      await page.getByRole("button", { name: "Run test message" }).click();
      await page.getByRole("button", { name: "Trace" }).last().click();
      await expect(page.getByTestId("test-trace")).toContainText("Paused (waiting for client)", {
        timeout: 30_000,
      });
      await settle(page);
      await save(
        page,
        "state-chatflow-paused-trace",
        "Chatflow editor: a test run paused on a Client Action, waiting for the client to return the tool result",
        false,
      );
      await page.getByRole("button", { name: "Close test drawer" }).click();
    });

    test("state: transcript with an agent run trace", async ({ page }) => {
      await page.goto(`/sessions/${demo.agentSession}`);
      await expect(page.getByText("Agent run trace")).toBeVisible();
      await page
        .getByRole("button", { name: /Lobby greeter/ })
        .first()
        .click();
      await expect(page.getByText("Check lobby status").first()).toBeVisible();
      await settle(page);
      await save(
        page,
        "state-session-agent-run",
        "Session transcript: an agent turn with its per-node run trace and session memory",
        true,
      );
    });
    test("state: API key shown once", async ({ page }) => {
      await page.goto("/api-keys");
      // Answer the create call locally: nothing is stored, so reruns never add keys, and the
      // key shown is the fixed demo value instead of a random one.
      await page.route("**/api/admin/api-keys", async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({ id: "demo", label: "Reception tablet", key: DEMO_API_KEY }),
        });
      });
      await settle(page);
      await page.getByRole("button", { name: "New API key" }).click();
      await page.getByRole("textbox", { name: "Label" }).fill("Reception tablet");
      await page.getByRole("button", { name: "Create key" }).click();
      await expect(page.getByText("won't be shown again")).toBeVisible();
      await settleDialog(page);
      await save(
        page,
        "state-api-key-created",
        "API Keys: the full key is shown exactly once, with a copy button",
        false,
      );
    });

    test("state: session transcript with thinking expanded", async ({ page }) => {
      await page.goto(`/sessions/${demo.reasoningSession}`);
      await expect(
        page.getByRole("heading", { name: "Session transcript", level: 1 }),
      ).toBeVisible();
      for (const trigger of await page.getByRole("button", { name: /^Thinking/ }).all()) {
        await trigger.click();
      }
      await expect(page.getByText("The user greets me.")).toBeVisible();
      await page.getByRole("button", { name: /^System prompt/ }).click();
      await settle(page);
      await save(
        page,
        "state-session-detail",
        "Session transcript: header, collapsible system prompt, expanded thinking blocks and Markdown replies",
        false,
      );
    });

    test("state: session transcript, full page", async ({ page }) => {
      await page.goto(`/sessions/${demo.reasoningSession}`);
      await expect(page.getByText("Turn 3", { exact: true })).toBeVisible();
      await settle(page);
      await save(
        page,
        "state-session-detail-full",
        "Session transcript: a long three-turn conversation with per-turn provider, latency and token metadata",
        true,
      );
    });

    test("state: session tool call card", async ({ page }) => {
      await page.goto(`/sessions/${demo.toolSession}`);
      await expect(page.getByText("show_image").first()).toBeVisible();
      await settle(page);
      await page.getByText("show_image").first().scrollIntoViewIfNeeded();
      await save(
        page,
        "state-session-tool-card",
        "Session transcript: a Unity tool call card with arguments, nested result and call-to-result duration",
        false,
        true,
      );
    });

    test("state: session with MCP tool calls", async ({ page }) => {
      await page.goto(`/sessions/${demo.mcpSession}`);
      await expect(page.getByText("composio__echo").first()).toBeVisible();
      await expect(
        page.locator('[data-slot="badge"]').filter({ hasText: "MCP" }).first(),
      ).toBeVisible();
      await settle(page);
      await page.getByText("composio__echo").first().scrollIntoViewIfNeeded();
      await save(
        page,
        "state-session-mcp-tools",
        "Session transcript: gateway-executed MCP tool calls with the MCP badge, arguments, nested results and duration",
        false,
        true,
      );
    });

    test("state: session with a built-in web_search call", async ({ page }) => {
      await page.goto(`/sessions/${demo.searchSession}`);
      await expect(page.getByText("web_search").first()).toBeVisible();
      await expect(
        page.locator('[data-slot="badge"]').filter({ hasText: "Built-in" }).first(),
      ).toBeVisible();
      await settle(page);
      await page.getByText("web_search").first().scrollIntoViewIfNeeded();
      await save(
        page,
        "state-session-builtin-tool",
        "Session transcript: a gateway-run built-in web_search call with the Built-in badge, arguments and nested results",
        false,
        true,
      );
    });

    test("state: MCP server dialog", async ({ page }) => {
      await page.goto("/mcp");
      await settle(page);
      await page.getByRole("button", { name: "New MCP server" }).click();
      await page.getByRole("textbox", { name: "Name" }).fill("GitHub");
      await page.getByRole("textbox", { name: "Slug" }).fill("github");
      await page
        .getByRole("textbox", { name: "Server URL" })
        .fill("https://mcp.example.com/github");
      await page.getByRole("textbox", { name: "Headers" }).fill("x-api-key: demo-not-a-real-key");
      await settleDialog(page);
      await save(
        page,
        "state-mcp-server-dialog",
        "MCP Servers: create dialog (headers are write-only and encrypted at rest)",
        false,
      );
    });

    test("state: MCP tools browser", async ({ page }) => {
      await page.goto("/mcp");
      await settle(page);
      await page.getByRole("button", { name: "Browse tools for Composio" }).click();
      await page.getByRole("button", { name: "Schema preview" }).first().click();
      await settleDialog(page);
      await save(
        page,
        "state-mcp-tools-browser",
        "MCP Servers: tools browser with allow switches and a JSON Schema preview",
        false,
      );
    });

    test("state: responses api session", async ({ page }) => {
      await page.goto(`/sessions/${demo.responsesSession}`);
      await expect(page.getByText("responses → chat")).toBeVisible();
      await expect(page.getByText("responses → responses")).toBeVisible();
      for (const trigger of await page.getByRole("button", { name: /^Thinking/ }).all()) {
        await trigger.click();
      }
      await settle(page);
      await save(
        page,
        "state-session-responses",
        "Session transcript: a Responses API session; the per-turn badge shows translated (responses -> chat) and native (responses -> responses) turns",
        false,
      );
    });

    test("state: failover attempts popover", async ({ page }) => {
      await page.goto(`/sessions/${demo.failoverSession}`);
      await page.getByRole("button", { name: "2 attempts" }).click();
      await expect(page.getByText("Failover attempts")).toBeVisible();
      await page.waitForTimeout(600);
      await save(
        page,
        "state-session-failover",
        "Session transcript: the failover popover lists every provider attempt and its outcome",
        false,
      );
    });

    test("state: ended session", async ({ page }) => {
      await page.goto(`/sessions/${demo.endedSession}`);
      await expect(page.getByRole("button", { name: "End session" })).toBeDisabled();
      await settle(page);
      await save(
        page,
        "state-session-ended",
        "Session transcript: a session an admin ended (no Live indicator, End session disabled)",
        false,
      );
    });

    test("state: sessions search", async ({ page }) => {
      await page.goto("/sessions");
      await settle(page);
      await page.getByLabel("Search transcripts").fill("sunset");
      await expect(page.getByTestId("sessions-range")).toHaveText("Showing 1-1 of 1");
      await save(page, "state-sessions-search", 'Sessions: full-text search for "sunset"', false);
    });

    test("state: sessions with standalone included", async ({ page }) => {
      await page.goto("/sessions");
      await settle(page);
      await page.getByLabel("Include standalone").click();
      await expect(page.getByText("Standalone", { exact: true }).first()).toBeVisible();
      await settle(page);
      await save(
        page,
        "state-sessions-standalone",
        "Sessions: one-shot helper calls are hidden by default and shown with a Standalone badge",
        false,
      );
    });

    test("state: bulk delete confirmation", async ({ page }) => {
      await page.goto("/sessions");
      await expect(page.getByRole("link", { name: /UTC$/ }).first()).toBeVisible();
      const boxes = page.getByRole("checkbox", { name: /^Select session/ });
      await boxes.nth(0).click();
      await boxes.nth(1).click();
      await page.getByRole("button", { name: /^Delete 2/ }).click();
      await expect(page.getByRole("alertdialog")).toBeVisible();
      await page.waitForTimeout(600);
      await save(
        page,
        "state-sessions-bulk-delete",
        "Sessions: bulk delete confirmation stating the deletion is permanent",
        false,
      );
      await page.getByRole("button", { name: "Cancel" }).click();
    });

    test("state: media upload dialog", async ({ page }) => {
      await page.goto("/media");
      await settle(page);
      await page.getByRole("button", { name: "Upload media" }).first().click();
      await page.getByTestId("media-file-input").setInputFiles([
        { name: "reception-desk.png", mimeType: "image/png", buffer: Buffer.alloc(300_000, 1) },
        { name: "welcome-loop.mp4", mimeType: "video/mp4", buffer: Buffer.alloc(2_400_000, 2) },
        { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("not media") },
      ]);
      await expect(page.getByRole("alert")).toBeVisible();
      await page.waitForTimeout(500);
      await save(
        page,
        "state-media-upload-dialog",
        "Media: upload dialog with drag-and-drop, queued files, limits and a rejected file",
        false,
      );
    });

    test("state: media edit dialog", async ({ page }) => {
      await page.goto("/media");
      await settle(page);
      await waitForMediaLoaded(page);
      await page.getByRole("button", { name: "Edit Sunset" }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.waitForTimeout(500);
      await save(
        page,
        "state-media-edit-dialog",
        "Media: edit dialog (the description is what the model uses to choose; tags select media per agent)",
        false,
      );
    });

    test("state: camera dialog", async ({ page }) => {
      await page.goto("/cameras");
      await settle(page);
      await page.getByRole("button", { name: "Edit Lobby camera" }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.waitForTimeout(500);
      await save(
        page,
        "state-camera-dialog",
        "Cameras: edit dialog for an MJPEG camera (credentials are write-only: only the masked username shows)",
        false,
      );
    });

    test("state: camera preview", async ({ page }) => {
      await page.goto("/cameras");
      await settle(page);
      await page.getByRole("button", { name: "Preview Lobby camera" }).click();
      const image = page.getByRole("img", { name: /Live preview/ });
      await expect(image).toBeVisible();
      await expect
        .poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth))
        .toBeGreaterThan(0);
      await page.waitForTimeout(500);
      await save(
        page,
        "state-camera-preview",
        "Cameras: live MJPEG preview through the admin-only proxy (Unity connects directly)",
        false,
      );
    });

    test("state: command palette", async ({ page }) => {
      await page.goto("/");
      await settle(page);
      await page.keyboard.press("Control+k");
      await expect(page.getByPlaceholder("Go to page...")).toBeVisible();
      await settleDialog(page);
      await save(page, "state-command-palette", "Ctrl+K command palette listing every page", false);
    });
  });
}
