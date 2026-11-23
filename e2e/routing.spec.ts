import { expect, test } from "@playwright/test";
import { type MockUpstream, startMockUpstream } from "../tests/support/mock-upstream";

const username = process.env.E2E_ADMIN_USERNAME ?? process.env.ADMIN_USERNAME ?? "";
const password = process.env.E2E_ADMIN_PASSWORD ?? process.env.ADMIN_PASSWORD ?? "";

const runId = Date.now().toString(36);
const providerName = `E2E Provider ${runId}`;
const routeSlug = `e2e-route-${runId}`;
const keyLabel = `E2E key ${runId}`;

test.use({ httpCredentials: { username, password } });
test.describe.configure({ mode: "serial" });

let upstream: MockUpstream;

test.beforeAll(async () => {
  upstream = await startMockUpstream({ models: ["ok", "mock-model"] });
});

test.afterAll(async () => {
  await upstream.close();
});

test("create a provider, test it, create a route and an API key, then call the gateway", async ({
  page,
  request,
}) => {
  // Provider
  await page.goto("/providers");
  await expect(page.getByRole("heading", { name: "Providers" })).toBeVisible();
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "New provider" }).click();
  await page.getByLabel("Name").fill(providerName);
  await page.getByLabel("Base URL").fill(upstream.url);
  await page.getByLabel("API key").fill("sk-e2e-not-a-real-key-0001");
  await page.getByRole("button", { name: "Create provider" }).click();
  const providerRow = page.getByRole("row", { name: new RegExp(providerName) });
  await expect(providerRow).toBeVisible();
  // The secret is masked, never shown.
  await expect(providerRow).toContainText("sk-…0001");
  await expect(page.getByText("sk-e2e-not-a-real-key-0001")).toHaveCount(0);

  await providerRow.getByRole("button", { name: "Test connection" }).click();
  await expect(page.getByRole("heading", { name: "Connection succeeded" })).toBeVisible();
  await expect(page.getByText("mock-model")).toBeVisible();
  await page.getByRole("button", { name: "Close", exact: true }).first().click();

  // Route
  await page.goto("/routes");
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "New route" }).click();
  await page.getByLabel("Slug").fill(routeSlug);
  await page.getByRole("combobox", { name: "Step 1 provider" }).click();
  await page.getByRole("option", { name: providerName }).click();
  await page.getByLabel("Upstream model").fill("ok");
  await page.getByRole("button", { name: "Create route" }).click();
  await expect(page.getByRole("row", { name: new RegExp(routeSlug) })).toBeVisible();

  // API key shown once
  await page.goto("/api-keys");
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "New API key" }).click();
  await page.getByLabel("Label").fill(keyLabel);
  await page.getByRole("button", { name: "Create key" }).click();
  const keyText = (await page.getByTestId("created-api-key").textContent()) ?? "";
  expect(keyText).toMatch(/^agx_[0-9A-Za-z]{32}$/);
  await expect(page.getByText("won't be shown again")).toBeVisible();
  await page.getByRole("button", { name: "I have saved the key" }).click();
  await expect(page.getByRole("row", { name: new RegExp(keyLabel) })).toContainText(
    keyText.slice(0, 8),
  );
  await expect(page.getByText(keyText)).toHaveCount(0);

  // The new key works against the gateway, routed to the mock upstream.
  const unauthorized = await request.get("/v1/models", {
    headers: { Authorization: "Bearer agx_invalid" },
    // Basic credentials from the context must not leak into the client API check.
  });
  expect(unauthorized.status()).toBe(401);

  const models = await request.get("/v1/models", {
    headers: { Authorization: `Bearer ${keyText}` },
  });
  expect(models.status()).toBe(200);
  expect((await models.json()).data.map((entry: { id: string }) => entry.id)).toContain(routeSlug);

  const completion = await request.post("/v1/chat/completions", {
    headers: { Authorization: `Bearer ${keyText}` },
    data: { model: routeSlug, messages: [{ role: "user", content: "hi" }] },
  });
  expect(completion.status()).toBe(200);
  expect(completion.headers()["x-gateway-provider"]).toBe(providerName);
  expect((await completion.json()).choices[0].message.content).toBe("Hello there");
  expect(upstream.chatRequests()[0].body?.model).toBe("ok");

  // Cleanup: revoke the key, then remove the route and provider.
  const keys = await (await request.get("/api/admin/api-keys")).json();
  const created = keys.data.find((entry: { label: string }) => entry.label === keyLabel);
  await request.post(`/api/admin/api-keys/${created.id}/revoke`);
  const routes = await (await request.get("/api/admin/routes")).json();
  const route = routes.data.find((entry: { slug: string }) => entry.slug === routeSlug);
  if (!route.is_default) {
    await request.delete(`/api/admin/routes/${route.id}`);
    const providers = await (await request.get("/api/admin/providers")).json();
    const provider = providers.data.find((entry: { name: string }) => entry.name === providerName);
    await request.delete(`/api/admin/providers/${provider.id}`);
  }
});
