import { type APIRequestContext, expect, request } from "@playwright/test";
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
export const CHAT_ROUTE = "layout-qa-failover";
export const SESSION_IDS_ENV = "LAYOUT_QA_SESSION_IDS";

/** Seeded session ids by scenario. */
export interface SessionIds {
  chat: string;
  reasoning: string;
  tools: string;
  ended: string;
  responses: string;
}
const sessionIds: SessionIds = { chat: "", reasoning: "", tools: "", ended: "", responses: "" };

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
  const admin = await request.newContext({ baseURL, httpCredentials: { username, password } });
  try {
    await seed(admin, upstream);
    await seedSessions(admin, baseURL);
  } finally {
    await admin.dispose();
  }
  process.env[SESSION_IDS_ENV] = JSON.stringify(sessionIds);
  return async () => {
    await upstream.close();
  };
}
