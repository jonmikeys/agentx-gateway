import { type APIRequestContext, expect, request } from "@playwright/test";
import { makePng } from "../tests/support/media-files";
import { type MockMcp, startMockMcp } from "../tests/support/mock-mcp";
import { type MockMediaServer, startMockMediaServer } from "../tests/support/mock-media-server";
import { type MockMjpeg, startMockMjpeg } from "../tests/support/mock-mjpeg";
import { type MockUpstream, startMockUpstream } from "../tests/support/mock-upstream";

/**
 * Seeds the nasty data used by e2e/layout.spec.ts once per run (Playwright global setup, so
 * parallel workers never race): long-named providers, a 10-step route, an emoji-labelled key and
 * sessions created through the real gateway. Providers, routes and the long key are reused; sessions are created fresh every run.
 */
const username = process.env.E2E_ADMIN_USERNAME ?? process.env.ADMIN_USERNAME ?? "";
const password = process.env.E2E_ADMIN_PASSWORD ?? process.env.ADMIN_PASSWORD ?? "";

export const providerNames = {
  long: "Layout QA provider with an extremely long title that keeps going 123",
  short: "Layout QA mock",
  // Fails every request, so its circuit breaker opening never affects the other providers.
  flaky: "Layout QA flaky",
  // Declares responses_api, so /v1/responses is forwarded to it natively.
  native: "Layout QA native Responses",
};
export const longBaseUrlPath = `/v1/${"a".repeat(120)}`;
export const routeSlug = "layout-qa-route-with-a-very-long-id-for-checking-layout-1234";
export const keyLabel = "Layout QA key \u{1F680} with a long text that keeps going and going on";
/** Media and cameras with long names, many tags and a long stream URL. */
export const mediaNames = {
  long: `Layout QA picture \u{1F305} with a very long display title that keeps going${" and going".repeat(2)}`,
  external: "Layout QA external picture",
  clip: "Layout QA external clip",
};
export const cameraNames = {
  good: `Layout QA camera with an extremely long display title that keeps going 123`,
  unreachable: "Layout QA unreachable camera",
  lookAt: "Layout QA look-at sidecar",
};
export const mcpServerName =
  "Layout QA MCP server with an extremely long display name that keeps going 123";
export const CHAT_ROUTE = "layout-qa-failover";
export const AGENT_FLOW_NAME =
  "Layout QA agent with an extremely long display name that keeps going and going 123";
export const AGENT_FLOW_ENV = "LAYOUT_QA_FLOW_ID";
export const SESSION_IDS_ENV = "LAYOUT_QA_SESSION_IDS";
export const SUBFLOW_FLOW_ENV = "LAYOUT_QA_SUBFLOW_ID";
export const subflowNames = {
  leaf: "Layout QA leaf subflow with a long display name that keeps going 123",
  caller: "Layout QA caller subflow with a long display name that keeps going 123",
};

async function seedMediaAndCameras(admin: APIRequestContext) {
  const names = async (collection: string) =>
    new Set(
      (
        ((await (await admin.get(`/api/admin/${collection}`)).json()).data ?? []) as {
          name: string;
        }[]
      ).map((item) => item.name),
    );
  const knownMedia = await names("media");
  const tags = [
    "layout",
    `a-very-long-tag-${"x".repeat(15)}`,
    "nature",
    "scenery",
    "brand",
    "info",
    "navigation",
    "video",
    "lobby",
    "demo",
  ];
  const upload = async (name: string, size: [number, number]) => {
    if (knownMedia.has(name)) return;
    const response = await admin.post("/api/admin/media/upload", {
      multipart: {
        name,
        description: `Layout QA ${"lorem ipsum ".repeat(30)}`,
        tags: tags.join(","),
        file: {
          name: `${name}.png`.slice(-120),
          mimeType: "image/png",
          buffer: makePng(size[0], size[1], [30, 120, 200]),
        },
      },
    });
    expect(response.status()).toBe(201);
  };
  await upload(mediaNames.long, [64, 48]);
  for (let index = 1; index <= 8; index += 1) {
    await upload(`Layout QA picture ${index}`, [48 + index, 36]);
  }
  const external = async (name: string, path: string) => {
    if (knownMedia.has(name)) return;
    const response = await admin.post("/api/admin/media", {
      data: { name, tags: ["layout", "external"], external_url: `${mediaServer.url}${path}` },
    });
    expect(response.status()).toBe(201);
  };
  await external(mediaNames.external, "/pic.png");
  await external(mediaNames.clip, "/clip.mp4");

  const knownCameras = new Map(
    (
      ((await (await admin.get("/api/admin/cameras")).json()).data ?? []) as {
        id: string;
        name: string;
      }[]
    ).map((item) => [item.name, item.id]),
  );
  const camera = async (data: Record<string, unknown>) => {
    const existing = knownCameras.get(data.name as string);
    if (existing) {
      // The mock stream gets a new port every run, so point a reused camera at the current one.
      if (data.url) {
        const response = await admin.patch(`/api/admin/cameras/${existing}`, {
          data: { url: data.url },
        });
        expect(response.status()).toBe(200);
      }
      return;
    }
    expect((await admin.post("/api/admin/cameras", { data })).status()).toBe(201);
  };
  await camera({
    type: "mjpeg_url",
    name: cameraNames.good,
    description: `Layout QA ${"a long camera description ".repeat(10)}`,
    url: mjpeg.streamUrl,
  });
  await camera({
    type: "mjpeg_url",
    name: cameraNames.unreachable,
    url: `${mjpeg.url}/${"p".repeat(120)}`,
  });
  await camera({
    type: "lookat_sidecar",
    name: cameraNames.lookAt,
    description: "Configured in the Unity app.",
  });
}

/** Seeded session ids by scenario. */
export interface SessionIds {
  chat: string;
  reasoning: string;
  tools: string;
  ended: string;
  responses: string;
}
let mediaServer: MockMediaServer;
let agentFlowId = "";
let subflowFlowId = "";
let mjpeg: MockMjpeg;
let mcp: MockMcp;
const sessionIds: SessionIds = { chat: "", reasoning: "", tools: "", ended: "", responses: "" };

/** Seeds a long-named MCP server, allows its tools and points the long route at one of them. */
async function seedMcp(admin: APIRequestContext) {
  const existing = ((await (await admin.get("/api/admin/mcp-servers")).json()).data ?? []) as {
    id: string;
    name: string;
    slug: string;
  }[];
  let server = existing.find((entry) => entry.name === mcpServerName);
  if (!server) {
    const response = await admin.post("/api/admin/mcp-servers", {
      data: {
        name: mcpServerName,
        slug: "layoutqamcp",
        url: mcp.url,
        transport: "streamable_http",
        headers: { "x-api-key": "sk-layout-qa-mcp-not-a-real-key" },
      },
    });
    expect(response.status()).toBe(201);
    server = (await response.json()) as { id: string; name: string; slug: string };
  } else {
    const response = await admin.patch(`/api/admin/mcp-servers/${server.id}`, {
      data: { url: mcp.url, transport: "streamable_http" },
    });
    expect(response.status()).toBe(200);
  }
  const refreshed = await admin.post(`/api/admin/mcp-servers/${server.id}/refresh-tools`);
  expect(refreshed.status()).toBe(200);
  const tools = ((await refreshed.json()).data ?? []) as { id: string; name: string }[];
  for (const tool of tools) {
    const response = await admin.patch(`/api/admin/mcp-tools/${tool.id}`, {
      data: { allowed: true },
    });
    expect(response.status()).toBe(200);
  }
  const routes = ((await (await admin.get("/api/admin/routes")).json()).data ?? []) as {
    id: string;
    slug: string;
    description: string;
    enabled: boolean;
    steps: { provider_id: string; upstream_model: string; timeout_ms: number }[];
  }[];
  const route = routes.find((entry) => entry.slug === routeSlug);
  if (route) {
    // Reuse the long route but make it carry a long MCP tool name in the editor picker.
    const response = await admin.put(`/api/admin/routes/${route.id}`, {
      data: {
        slug: route.slug,
        description: route.description,
        enabled: route.enabled,
        steps: route.steps,
        mcp_tool_ids: tools.map((tool) => tool.id),
      },
    });
    expect(response.status()).toBe(200);
  }
}

async function seedAgent(admin: APIRequestContext) {
  const flows = ((await (await admin.get("/api/admin/flows")).json()).data ?? []) as {
    id: string;
    slug: string;
    published_version: number | null;
  }[];
  let flow = flows.find((entry) => entry.slug === "layout-qa-agent");
  if (!flow) {
    const response = await admin.post("/api/admin/flows", {
      data: {
        name: AGENT_FLOW_NAME,
        slug: "layout-qa-agent",
        description: `Layout QA ${"a chatflow description ".repeat(10)}`,
        enabled: true,
      },
    });
    expect(response.status()).toBe(201);
    flow = (await response.json()) as {
      id: string;
      slug: string;
      published_version: number | null;
    };
  }
  const longTitle = `A node title that is long enough to stress the card ${"x".repeat(30)}`;
  const start = {
    id: "start_layout",
    type: "start",
    position: { x: 0, y: 0 },
    data: { title: "Start of the layout QA agent" },
  };
  const llm = {
    id: "llm_layout",
    type: "llm",
    position: { x: 280, y: 0 },
    data: {
      title: longTitle,
      model: "inherit",
      systemPrompt: "You are a helpful layout QA assistant. ".repeat(20),
      history: "full",
      historyLimit: 10,
      mcpToolIds: [],
      outputVariable: "llm_output",
      stream: true,
    },
  };
  const reply = {
    id: "reply_layout",
    type: "reply",
    position: { x: 560, y: 0 },
    data: { title: "Reply with a long template", template: "Layout QA says: {{vars.llm_output}}" },
  };
  const end = {
    id: "end_layout",
    type: "end",
    position: { x: 840, y: 0 },
    data: { title: "End" },
  };
  const graph = {
    nodes: [start, llm, reply, end],
    edges: [
      { id: "e_start_llm", source: start.id, target: llm.id, sourceHandle: "out" },
      { id: "e_llm_reply", source: llm.id, target: reply.id, sourceHandle: "out" },
      { id: "e_reply_end", source: reply.id, target: end.id, sourceHandle: "out" },
    ],
  };
  const drafted = await admin.put(`/api/admin/flows/${flow.id}/draft`, { data: { graph } });
  expect(drafted.status()).toBe(200);
  if (flow.published_version === null) {
    const published = await admin.post(`/api/admin/flows/${flow.id}/publish`, {
      data: { note: "Layout QA version" },
    });
    expect(published.status()).toBe(201);
  }
  agentFlowId = flow.id;
}

/**
 * Seeds a published leaf subflow and a published caller subflow, so the layout checks can open
 * the Subflow Input/Output and Call Subflow property panels.
 */
async function seedSubflows(admin: APIRequestContext) {
  const flows = ((await (await admin.get("/api/admin/flows")).json()).data ?? []) as {
    id: string;
    slug: string;
    published_version: number | null;
  }[];
  const ensureFlow = async (name: string, slug: string) => {
    const existing = flows.find((entry) => entry.slug === slug);
    if (existing) return existing;
    const response = await admin.post("/api/admin/flows", {
      data: { name, slug, kind: "subflow", description: "", enabled: true },
    });
    expect(response.status()).toBe(201);
    return (await response.json()) as {
      id: string;
      slug: string;
      published_version: number | null;
    };
  };
  const publish = async (id: string) => {
    const response = await admin.post(`/api/admin/flows/${id}/publish`, {
      data: { note: "Layout QA subflow" },
    });
    expect(response.status()).toBe(201);
  };

  const leaf = await ensureFlow(subflowNames.leaf, "layout-qa-subflow-leaf");
  const leafInput = {
    id: "input_leaf",
    type: "subflow_input",
    position: { x: 0, y: 0 },
    data: { title: "Input with a long title that stresses the card", params: [] },
  };
  const leafOutput = {
    id: "output_leaf",
    type: "subflow_output",
    position: { x: 320, y: 0 },
    data: {
      title: "Output",
      label: "result",
      values: [{ name: "value", value: "leaf: {{input.text}}" }],
    },
  };
  const leafDraft = await admin.put(`/api/admin/flows/${leaf.id}/draft`, {
    data: {
      graph: {
        nodes: [leafInput, leafOutput],
        edges: [{ id: "e_leaf", source: leafInput.id, target: leafOutput.id, sourceHandle: "out" }],
      },
    },
  });
  expect(leafDraft.status()).toBe(200);
  if (leaf.published_version === null) await publish(leaf.id);

  const caller = await ensureFlow(subflowNames.caller, "layout-qa-subflow-caller");
  const input = {
    id: "input_caller",
    type: "subflow_input",
    position: { x: 0, y: 0 },
    data: {
      title: "Input",
      params: [
        { name: "topic", type: "string", required: false },
        {
          name: "a_very_long_parameter_name_that_stresses_the_panel",
          type: "json",
          required: false,
        },
      ],
    },
  };
  const call = {
    id: "call_caller",
    type: "call_subflow",
    position: { x: 300, y: 0 },
    data: {
      title: "Call the leaf with a long title that stresses the card",
      subflowId: leaf.id,
      subflowName: subflowNames.leaf,
      inputs: [{ name: "topic", value: "{{input.text}}" }],
      outputs: [{ label: "result", variable: "leaf_result" }],
    },
  };
  const output = {
    id: "output_caller",
    type: "subflow_output",
    position: { x: 640, y: 0 },
    data: {
      title: "Output",
      label: "result",
      values: [{ name: "value", value: "{{vars.leaf_result}}" }],
    },
  };
  const callerDraft = await admin.put(`/api/admin/flows/${caller.id}/draft`, {
    data: {
      graph: {
        nodes: [input, call, output],
        edges: [
          { id: "e_in", source: input.id, target: call.id, sourceHandle: "out" },
          { id: "e_out", source: call.id, target: output.id, sourceHandle: "out:result" },
        ],
      },
    },
  });
  expect(callerDraft.status()).toBe(200);
  if (caller.published_version === null) await publish(caller.id);
  subflowFlowId = caller.id;
}

async function seed(admin: APIRequestContext, upstream: MockUpstream) {
  const list = async (collection: string) =>
    ((await (await admin.get(`/api/admin/${collection}`)).json()).data ?? []) as Record<
      string,
      string
    >[];
  const ids: Record<string, string> = {};
  const providers = [
    { name: providerNames.long, base_url: `${upstream.url}${longBaseUrlPath}` },
    { name: providerNames.short, base_url: upstream.url },
    { name: providerNames.flaky, base_url: upstream.url },
    { name: providerNames.native, base_url: upstream.url, responsesApi: true },
  ];
  for (const { name, base_url, responsesApi } of providers) {
    const found = (await list("providers")).find((provider) => provider.name === name);
    if (found) {
      ids[name] = found.id;
      // The mock upstream gets a new port every run, so point reused rows at the current one.
      if (found.base_url !== base_url) {
        const response = await admin.patch(`/api/admin/providers/${found.id}`, {
          data: { base_url },
        });
        expect(response.status()).toBe(200);
      }
      continue;
    }
    const response = await admin.post("/api/admin/providers", {
      data: {
        name,
        base_url,
        api_key: "sk-layout-qa-not-a-real-key",
        ...(responsesApi
          ? { capabilities: { streaming: true, tools: true, responses_api: true } }
          : {}),
      },
    });
    expect(response.status()).toBe(201);
    ids[name] = (await response.json()).id;
  }
  if (!(await list("routes")).some((route) => route.slug === routeSlug)) {
    const steps = Array.from({ length: 10 }, (_, index) => ({
      provider_id: index % 2 === 0 ? ids[providerNames.long] : ids[providerNames.short],
      upstream_model: `vendor/extremely-long-model-name-${"x".repeat(50)}-v${index}`,
      timeout_ms: 20000,
    }));
    const response = await admin.post("/api/admin/routes", {
      data: { slug: routeSlug, description: `Layout QA ${"lorem ipsum ".repeat(15)}`, steps },
    });
    expect(response.status()).toBe(201);
  }
  if (!(await list("api-keys")).some((key) => key.label === keyLabel)) {
    const response = await admin.post("/api/admin/api-keys", {
      data: {
        label: keyLabel,
        rpm_limit: 60,
        ip_allowlist: ["203.0.113.0/24", "2001:db8::/32", "198.51.100.0/24", "192.0.2.0/24"],
      },
    });
    expect(response.status()).toBe(201);
  }
}

type Message = Record<string, unknown>;

/**
 * Seeds sessions through the real gateway: a long failover conversation with nasty text, a
 * reasoning session, a tool-call session and an ended session. Reused when it already exists.
 */
async function seedSessions(admin: APIRequestContext, baseURL: string) {
  const providers = ((await (await admin.get("/api/admin/providers")).json()).data ?? []) as {
    id: string;
    name: string;
  }[];
  const flakyId = providers.find((provider) => provider.name === providerNames.flaky)?.id;
  const nativeId = providers.find((provider) => provider.name === providerNames.native)?.id;
  const shortId = providers.find((provider) => provider.name === providerNames.short)?.id;
  const routes: [string, [string | undefined, string][]][] = [
    [
      CHAT_ROUTE,
      [
        [flakyId, "fail-503"],
        [shortId, "echo"],
      ],
    ],
    ["layout-qa-reasoning", [[shortId, "reasoning"]]],
    ["layout-qa-tools", [[shortId, "tool-call"]]],
    ["layout-qa-ended", [[shortId, "echo"]]],
    ["layout-qa-responses-chat", [[shortId, "reasoning"]]],
    ["layout-qa-responses-native", [[nativeId, "echo"]]],
  ];
  const existingRoutes = ((await (await admin.get("/api/admin/routes")).json()).data ?? []) as {
    slug: string;
  }[];
  for (const [slug, steps] of routes) {
    if (existingRoutes.some((route) => route.slug === slug)) continue;
    const response = await admin.post("/api/admin/routes", {
      data: {
        slug,
        steps: steps.map(([providerId, model]) => ({
          provider_id: providerId,
          upstream_model: model,
          timeout_ms: 20000,
        })),
      },
    });
    expect(response.status()).toBe(201);
  }

  // Sessions are created fresh every run: an idle-expired session would no longer show the Live
  // indicator, so reusing last run's rows would make the live-state checks flaky.
  const key = await (
    await admin.post("/api/admin/api-keys", { data: { label: "Layout QA sessions" } })
  ).json();
  const gateway = await request.newContext({
    baseURL,
    extraHTTPHeaders: { Authorization: `Bearer ${key.key}` },
  });
  const chat = async (model: string, messages: Message[], sessionId?: string) => {
    const response = await gateway.post("/v1/chat/completions", {
      data: { model, stream: true, messages },
      headers: sessionId ? { "X-Session-Id": sessionId } : {},
    });
    expect(response.status()).toBe(200);
    await response.text();
    return response.headers()["x-session-id"] as string;
  };

  const nasty = [
    `Unbroken token: ${"x".repeat(180)}`,
    `Emoji \u{1F680}\u{1F389} and a [long link](https://example.com/${"a".repeat(120)})`,
    `\`\`\`ts\nconst veryLongLine = '${"y".repeat(160)}';\n\`\`\``,
    `A long paragraph. ${"Lorem ipsum dolor sit amet, ".repeat(25)}`,
  ];
  const history: Message[] = [
    { role: "system", content: `You are Aiko. ${"Keep answers short. ".repeat(20)}` },
  ];
  let chatId: string | undefined;
  for (let turn = 0; turn < 8; turn += 1) {
    history.push({ role: "user", content: nasty[turn % nasty.length] });
    chatId = await chat(CHAT_ROUTE, [...history], chatId);
    history.push({ role: "assistant", content: `Echo: ${nasty[turn % nasty.length]}` });
  }
  sessionIds.chat = chatId as string;
  sessionIds.reasoning = await chat("layout-qa-reasoning", [{ role: "user", content: "Think." }]);

  const toolFirst: Message[] = [{ role: "user", content: "Show me a sunset" }];
  sessionIds.tools = await chat("layout-qa-tools", toolFirst);
  await chat(
    "layout-qa-tools",
    [
      ...toolFirst,
      {
        role: "assistant",
        content: "Let me show that. ",
        tool_calls: [
          {
            id: "call_mock_1",
            type: "function",
            function: { name: "show_image", arguments: `{"media_id":"${"s".repeat(120)}"}` },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_mock_1", content: "Image shown" },
    ],
    sessionIds.tools,
  );

  // Responses API client: a translated turn (responses -> chat), then a native one.
  const responsesTurn = async (model: string, input: Message[], sessionId?: string) => {
    const response = await gateway.post("/v1/responses", {
      data: { model, stream: true, input, instructions: "You are Aiko." },
      headers: sessionId ? { "X-Session-Id": sessionId } : {},
    });
    expect(response.status()).toBe(200);
    await response.text();
    return response.headers()["x-session-id"] as string;
  };
  sessionIds.responses = await responsesTurn("layout-qa-responses-chat", [
    { role: "user", content: nasty[0] },
  ]);
  await expect
    .poll(async () => {
      const detail = await (await admin.get(`/api/admin/sessions/${sessionIds.responses}`)).json();
      return detail.turn_count ?? 0;
    })
    .toBeGreaterThan(0);
  await responsesTurn(
    "layout-qa-responses-native",
    [
      { role: "user", content: nasty[0] },
      { role: "assistant", content: "Hello." },
      { role: "user", content: nasty[1] },
    ],
    sessionIds.responses,
  );
  // Both turns must be persisted before the tests assert on the transcript.
  await expect
    .poll(async () => {
      const detail = await (await admin.get(`/api/admin/sessions/${sessionIds.responses}`)).json();
      return detail.turn_count ?? 0;
    })
    .toBe(2);

  sessionIds.ended = await chat("layout-qa-ended", [{ role: "user", content: "Bye." }]);
  // Requests persist asynchronously; ending too early would race the transcript write.
  await expect
    .poll(async () => {
      const detail = await (await admin.get(`/api/admin/sessions/${sessionIds.ended}`)).json();
      return detail.turn_count ?? 0;
    })
    .toBeGreaterThan(0);
  expect((await admin.post(`/api/admin/sessions/${sessionIds.ended}/end`)).status()).toBe(200);
  await gateway.dispose();
}

export default async function globalSetup() {
  const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:3000";
  const upstream = await startMockUpstream({ models: ["ok", "mock-model"] });
  mediaServer = await startMockMediaServer();
  mjpeg = await startMockMjpeg({ frameIntervalMs: 50 });
  mcp = await startMockMcp({ slowMs: 500 });
  const admin = await request.newContext({ baseURL, httpCredentials: { username, password } });
  try {
    await seed(admin, upstream);
    await seedAgent(admin);
    await seedSubflows(admin);
    await seedMcp(admin);
    await seedMediaAndCameras(admin);
    await seedSessions(admin, baseURL);
  } finally {
    await admin.dispose();
  }
  process.env[SESSION_IDS_ENV] = JSON.stringify(sessionIds);
  process.env[AGENT_FLOW_ENV] = agentFlowId;
  process.env[SUBFLOW_FLOW_ENV] = subflowFlowId;
  return async () => {
    await upstream.close();
    await mediaServer.close();
    await mjpeg.close();
    await mcp.close();
  };
}
