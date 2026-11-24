import { expect, test } from "@playwright/test";
import { type MockSearxng, startMockSearxng } from "../tests/support/mock-searxng";
import { type MockUpstream, startMockUpstream } from "../tests/support/mock-upstream";

const username = process.env.E2E_ADMIN_USERNAME ?? process.env.ADMIN_USERNAME ?? "";
const password = process.env.E2E_ADMIN_PASSWORD ?? process.env.ADMIN_PASSWORD ?? "";
// When set, the server's SEARXNG_URL must point at this port; the spec then runs a real search.
const searxngPort = process.env.E2E_SEARXNG_PORT ? Number(process.env.E2E_SEARXNG_PORT) : undefined;

const runId = Date.now().toString(36);
const providerName = `E2E Search Provider ${runId}`;
const routeSlug = `e2e-search-route-${runId}`;
const keyLabel = `E2E search key ${runId}`;
const toolNames = ["web_search", "read_web_page", "image_search", "video_search"] as const;

test.use({ httpCredentials: { username, password } });
test.describe.configure({ mode: "serial" });

let upstream: MockUpstream;
let searxng: MockSearxng | undefined;
let providerId = "";
let routeId = "";

test.beforeAll(async ({ playwright, baseURL }) => {
  upstream = await startMockUpstream({ models: ["gateway-tool"] });
  if (searxngPort) searxng = await startMockSearxng({ port: searxngPort });
  const admin = await playwright.request.newContext({
    baseURL,
    httpCredentials: { username, password },
  });
  const provider = await admin.post("/api/admin/providers", {
    data: {
      name: providerName,
      base_url: upstream.url,
      api_key: "sk-e2e-not-a-real-key-0002",
      capabilities: { streaming: true, tools: true, responses_api: false },
    },
  });
  expect(provider.status()).toBe(201);
  providerId = (await provider.json()).id;
  const route = await admin.post("/api/admin/routes", {
    data: {
      slug: routeSlug,
      description: "E2E built-in tools",
      steps: [{ provider_id: providerId, upstream_model: "gateway-tool", timeout_ms: 20000 }],
    },
  });
  expect(route.status()).toBe(201);
  routeId = (await route.json()).id;
  await admin.dispose();
});

test.afterAll(async ({ playwright, baseURL }) => {
  const admin = await playwright.request.newContext({
    baseURL,
    httpCredentials: { username, password },
  });
  if (routeId) await admin.delete(`/api/admin/routes/${routeId}`);
  if (providerId) await admin.delete(`/api/admin/providers/${providerId}`);
  await admin.dispose();
  await upstream.close();
  await searxng?.close();
});

test("the route editor lists the four built-in tools, off by default, and saves a selection", async ({
  page,
  request,
}) => {
  const catalogue = (await (await request.get("/api/admin/builtin-tools")).json()).data as {
    name: string;
    available: boolean;
  }[];
  expect(catalogue.map((tool) => tool.name)).toEqual([...toolNames]);
  const webSearchAvailable = catalogue.find((tool) => tool.name === "web_search")?.available;

  await page.goto("/routes");
  await page.waitForLoadState("networkidle");
  const row = page.getByRole("row", { name: new RegExp(routeSlug) });
  await expect(row).toBeVisible();
  // The Tools column counts MCP plus built-in tools.
  await expect(row.getByTitle("0 MCP, 0 built-in")).toHaveText("0");

  await page.getByRole("button", { name: `Edit ${routeSlug}` }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Built-in tools" })).toBeVisible();
  for (const name of toolNames) {
    const box = dialog.locator(`#route-builtin-${name}`);
    await expect(box).toBeVisible();
    await expect(box).not.toBeChecked();
  }
  await expect(dialog.getByText("0 selected").first()).toBeVisible();

  // The availability follows the server configuration (SEARXNG_URL).
  const webSearchLabel = dialog.locator("label[for='route-builtin-web_search']");
  if (webSearchAvailable) {
    await expect(webSearchLabel.getByText("Not configured")).toHaveCount(0);
    expect(searxngPort, "a configured server needs a mock SearXNG").toBeDefined();
  } else {
    await expect(webSearchLabel.getByText("Not configured")).toBeVisible();
    await expect(dialog.getByText(/Unavailable:/).first()).toBeVisible();
  }

  await dialog.getByRole("checkbox", { name: /\bweb_search\b/ }).check();
  await expect(dialog.getByText("1 selected").first()).toBeVisible();
  await dialog.getByRole("button", { name: "Save route" }).click();
  await expect(page.getByText("Route updated")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await expect(row.getByTitle("0 MCP, 1 built-in")).toHaveText("1");

  const stored = (await (await request.get("/api/admin/routes")).json()).data.find(
    (entry: { slug: string }) => entry.slug === routeSlug,
  );
  expect(stored.builtin_tools).toEqual(["web_search"]);

  // Reopening shows the saved selection.
  await page.getByRole("button", { name: `Edit ${routeSlug}` }).click();
  const reopened = page.getByRole("dialog");
  await expect(reopened.getByRole("checkbox", { name: /\bweb_search\b/ })).toBeChecked();
  await expect(reopened.getByRole("checkbox", { name: /\bread_web_page\b/ })).not.toBeChecked();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("a built-in tool call is run by the gateway and recorded with a Built-in badge", async ({
  page,
  request,
}) => {
  test.skip(!searxng, "needs E2E_SEARXNG_PORT and a server whose SEARXNG_URL points at it");
  const created = await request.post("/api/admin/api-keys", { data: { label: keyLabel } });
  expect(created.status()).toBe(201);
  const key = (await created.json()) as { id: string; key: string };
  try {
    const completion = await request.post("/v1/chat/completions", {
      headers: { Authorization: `Bearer ${key.key}` },
      data: {
        model: routeSlug,
        messages: [
          {
            role: "user",
            content: JSON.stringify({ tool: "web_search", args: { query: "red panda" } }),
          },
        ],
      },
    });
    expect(completion.status()).toBe(200);
    const body = await completion.json();
    expect(body.choices[0].message.content).toContain("Red panda - Wikipedia");
    expect(searxng?.searches.map((search) => search.q)).toContain("red panda");

    const sessionId = completion.headers()["x-session-id"];
    expect(sessionId).toBeTruthy();
    await page.goto(`/sessions/${sessionId}`);
    await expect(page.getByText("web_search").first()).toBeVisible();
    await expect(
      page.locator('[data-slot="badge"]').filter({ hasText: "Built-in" }).first(),
    ).toBeVisible();
  } finally {
    await request.post(`/api/admin/api-keys/${key.id}/revoke`);
  }
});
