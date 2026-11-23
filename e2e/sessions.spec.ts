import { expect, test } from "@playwright/test";
import { type MockUpstream, startMockUpstream } from "../tests/support/mock-upstream";

const username = process.env.E2E_ADMIN_USERNAME ?? process.env.ADMIN_USERNAME ?? "";
const password = process.env.E2E_ADMIN_PASSWORD ?? process.env.ADMIN_PASSWORD ?? "";

const runId = Date.now().toString(36);
const searchWord = `kiwi${runId}`;

test.use({ httpCredentials: { username, password } });
test.describe.configure({ mode: "serial" });

let upstream: MockUpstream;
let clientKey = "";
let reasoningSessionId = "";
let toolSessionId = "";

test.beforeAll(async ({ playwright }) => {
  upstream = await startMockUpstream({ models: ["reasoning", "tool-call", "echo"] });
  const admin = await playwright.request.newContext({
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    httpCredentials: { username, password },
  });
  const provider = await (
    await admin.post("/api/admin/providers", {
      data: { name: `E2E Sessions ${runId}`, base_url: upstream.url },
    })
  ).json();
  for (const model of ["reasoning", "tool-call", "echo"]) {
    const response = await admin.post("/api/admin/routes", {
      data: {
        slug: `e2e-${model}-${runId}`,
        steps: [{ provider_id: provider.id, upstream_model: model, timeout_ms: 20000 }],
      },
    });
    expect(response.status()).toBe(201);
  }
  const key = await (
    await admin.post("/api/admin/api-keys", { data: { label: `E2E sessions ${runId}` } })
  ).json();
  clientKey = key.key;
  await admin.dispose();

  const gateway = await playwright.request.newContext({
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    extraHTTPHeaders: { Authorization: `Bearer ${clientKey}` },
  });
  const chat = async (model: string, messages: unknown[], sessionId?: string) => {
    const response = await gateway.post("/v1/chat/completions", {
      data: { model: `e2e-${model}-${runId}`, stream: true, messages },
      headers: sessionId ? { "X-Session-Id": sessionId } : {},
    });
    expect(response.status()).toBe(200);
    await response.text();
    return response.headers()["x-session-id"] as string;
  };

  reasoningSessionId = await chat("reasoning", [
    { role: "user", content: `Hello ${searchWord}, please think first` },
  ]);
  toolSessionId = await chat("tool-call", [{ role: "user", content: "Show me a sunset" }]);
  await chat(
    "tool-call",
    [
      { role: "user", content: "Show me a sunset" },
      {
        role: "assistant",
        content: "Let me show that. ",
        tool_calls: [
          {
            id: "call_mock_1",
            type: "function",
            function: { name: "show_image", arguments: '{"media_id":"sunset"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_mock_1", content: "Image shown" },
    ],
    toolSessionId,
  );
  await gateway.dispose();
});

test.afterAll(async () => {
  await upstream.close();
});

test("search finds a session by transcript text", async ({ page }) => {
  await page.goto("/sessions");
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Search transcripts").fill(searchWord);
  await expect(page.getByTestId("sessions-range")).toHaveText("Showing 1-1 of 1");
  await expect(page.getByRole("row")).toHaveCount(2);
  await page.getByLabel("Search transcripts").fill(`nomatch${runId}`);
  await expect(page.getByTestId("sessions-range")).toHaveText("No sessions");
});

test("transcript shows collapsible thinking and the assistant reply", async ({ page }) => {
  await page.goto(`/sessions/${reasoningSessionId}`);
  await expect(page.getByTestId("live-indicator")).toBeVisible();
  await expect(page.getByText("Hello from the reasoning model.")).toBeVisible();
  // Thinking is collapsed by default and expands on click.
  await expect(page.getByText("The user greets me.")).toBeHidden();
  await page.getByRole("button", { name: /^Thinking/ }).click();
  await expect(page.getByText("The user greets me.")).toBeVisible();
});

test("transcript shows a tool-call card with its nested result", async ({ page }) => {
  await page.goto(`/sessions/${toolSessionId}`);
  await expect(page.getByText("show_image")).toBeVisible();
  await expect(page.getByText("Unity", { exact: true })).toBeVisible();
  await expect(page.getByText("Image shown")).toBeVisible();
  await expect(page.getByText("I put the image on screen.")).toBeVisible();
});

test("ending a session stops it and the client gets session_not_found", async ({
  page,
  request,
}) => {
  await page.goto(`/sessions/${reasoningSessionId}`);
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "End session" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "End session" }).click();
  await expect(page.getByTestId("live-indicator")).toBeHidden();
  await expect(page.getByRole("button", { name: "End session" })).toBeDisabled();

  const response = await request.post("/v1/chat/completions", {
    headers: { Authorization: `Bearer ${clientKey}`, "X-Session-Id": reasoningSessionId },
    data: { model: `e2e-echo-${runId}`, messages: [{ role: "user", content: "again" }] },
  });
  expect(response.status()).toBe(404);
  expect((await response.json()).error.code).toBe("session_not_found");
});
