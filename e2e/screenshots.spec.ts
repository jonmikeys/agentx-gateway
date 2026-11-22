import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  type APIRequestContext,
  expect,
  request as playwrightRequest,
  test,
} from "@playwright/test";
import postgres from "postgres";
import { navGroups } from "../src/components/app-shell/nav";
import { type MockUpstream, startMockUpstream } from "../tests/support/mock-upstream";

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
const MOCK_PORT = Number(process.env.MOCK_UPSTREAM_PORT ?? 4010);
const databaseUrl =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgres://agentx:agentx@localhost:5432/agentx";
const themes = ["light", "dark"] as const;

interface Captured {
  file: string;
  caption: string;
}
const captured: Captured[] = [];

let upstream: MockUpstream;
let admin: APIRequestContext;
let gateway: APIRequestContext;
const demo = {
  reasoningSession: "",
  toolSession: "",
  endedSession: "",
  failoverSession: "",
  responsesSession: "",
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

  const routes: { slug: string; description: string; steps: [string, string][] }[] = [
    {
      slug: "avatar-default",
      description: "Default avatar conversation model with failover",
      steps: [
        ["OpenAI", "ok"],
        ["DeepSeek", "mock-model"],
      ],
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
  ];
  for (const route of routes) {
    if ((await existing("routes")).some((entry) => entry.slug === route.slug)) continue;
    const response = await admin.post("/api/admin/routes", {
      data: {
        slug: route.slug,
        description: route.description,
        steps: route.steps.map(([provider, model], index) => ({
          provider_id: providerIds[provider],
          upstream_model: model,
          timeout_ms: index === 0 ? 20000 : 30000,
        })),
      },
    });
    expect(response.status()).toBe(201);
  }

  const kioskExists = (await existing("api-keys")).some((key) => key.label === "Lobby kiosk");
  const response = await admin.post("/api/admin/api-keys", {
    data: {
      label: kioskExists ? "Lobby kiosk (extra)" : "Lobby kiosk",
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
    models: ["ok", "mock-model", "gpt-demo"],
  });
  admin = await playwrightRequest.newContext({
    baseURL,
    httpCredentials: { username, password },
  });
  const clientKey = await seedDemoData();
  gateway = await playwrightRequest.newContext({
    baseURL,
    extraHTTPHeaders: { Authorization: `Bearer ${clientKey}` },
  });
  await seedSessions();
});

test.afterAll(async () => {
  await admin.dispose();
  await gateway.dispose();
  await upstream.close();
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

    async function settle(page: import("@playwright/test").Page) {
      await page.waitForLoadState("networkidle");
      await page.evaluate(() => document.fonts.ready);
      // Charts animate in; wait for them to finish before capturing.
      await page.waitForTimeout(800);
    }

    async function save(
      page: import("@playwright/test").Page,
      name: string,
      caption: string,
      fullPage: boolean,
    ) {
      const file = `${name}-${theme}.png`;
      await page.screenshot({ path: path.join(outputDir, file), fullPage });
      captured.push({ file, caption: `${caption} (${theme} theme)` });
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
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.getByLabel("Responses API").scrollIntoViewIfNeeded();
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
      await expect(page.getByRole("dialog")).toBeVisible();
      await expect(page.getByRole("button", { name: "Move step 2 up" })).toBeVisible();
      await page.waitForTimeout(500);
      await save(
        page,
        "state-route-editor",
        "Model Routes: editor with two ordered failover steps (drag handle and arrow buttons)",
        false,
      );
    });

    test("state: API key shown once", async ({ page }) => {
      await page.goto("/api-keys");
      await settle(page);
      await page.getByRole("button", { name: "New API key" }).click();
      await page.getByLabel("Label").fill(`Reception tablet (${theme})`);
      await page.getByRole("button", { name: "Create key" }).click();
      await expect(page.getByText("won't be shown again")).toBeVisible();
      // The key differs on every run; mask the digits so regenerated images stay stable.
      await page.getByTestId("created-api-key").evaluate((node) => {
        node.textContent = `agx_${"x".repeat(32)}`;
      });
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
        "Session transcript: a Responses API session; the per-turn badge shows translated (responses → chat) and native (responses → responses) turns",
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

    test("state: command palette", async ({ page }) => {
      await page.goto("/");
      await settle(page);
      await page.keyboard.press("Control+k");
      await expect(page.getByPlaceholder("Go to page...")).toBeVisible();
      await save(page, "state-command-palette", "Ctrl+K command palette listing every page", false);
    });
  });
}
