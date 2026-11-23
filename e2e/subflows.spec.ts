import { expect, request, test } from "@playwright/test";

/**
 * G7b subflows end-to-end: build and publish a subflow, wire it into an agent's Call Subflow
 * node in the editor, publish the agent and run it from the test drawer.
 */
const username = process.env.E2E_ADMIN_USERNAME ?? process.env.ADMIN_USERNAME ?? "";
const password = process.env.E2E_ADMIN_PASSWORD ?? process.env.ADMIN_PASSWORD ?? "";
const runId = Date.now().toString(36);

test.use({
  httpCredentials: { username, password },
  viewport: { width: 1440, height: 900 },
  reducedMotion: "reduce",
});
test.describe.configure({ mode: "default" });

test("call a published subflow from an agent and run it", async ({ page, baseURL }) => {
  const subflowName = `E2E subflow ${runId}`;
  await page.goto("/chatflows");
  await expect(page.getByRole("heading", { name: "Chatflows", level: 1 })).toBeVisible();

  // Filter: the Agents / Subflows toggle narrows the list.
  const subflowsFilter = page.getByRole("button", { name: /^Subflows/ });
  await subflowsFilter.click();
  await expect(subflowsFilter).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: /^All/ }).click();

  await page.getByRole("button", { name: "New subflow" }).click();
  await page.getByRole("textbox", { name: "Name" }).fill(subflowName);
  await page.getByRole("button", { name: "Create subflow" }).click();
  await expect(page.getByRole("heading", { name: subflowName, level: 1 })).toBeVisible();
  await expect(page.getByText("Subflow", { exact: true }).first()).toBeVisible();

  // Declare a required input and one return value.
  await page.locator('[data-node-type="subflow_input"]').click({ position: { x: 12, y: 12 } });
  await page.getByRole("button", { name: "Add parameter" }).click();
  await page.getByLabel("Parameter 1 name").fill("topic");

  await page.locator('[data-node-type="subflow_output"]').click({ position: { x: 12, y: 12 } });
  await page.getByRole("button", { name: "Add return value" }).click();
  await page.getByPlaceholder("Return value for value").fill("{{vars.topic}}");

  await page.waitForTimeout(1400);
  await expect(page.getByTestId("save-indicator")).toContainText("Saved");

  await page.getByRole("button", { name: "Publish", exact: true }).click();
  const publishDialog = page.getByRole("dialog");
  await expect(publishDialog.getByText("Validation passed.")).toBeVisible();
  await publishDialog.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByText("Published version 1")).toBeVisible();
  const subflowId = page.url().split("/chatflows/")[1];
  expect(subflowId).toMatch(/^agt_/);

  // Seed the agent with a Call Subflow node whose target and output branch are not set yet.
  const api = await request.newContext({
    baseURL: baseURL ?? "http://localhost:3700",
    httpCredentials: { username, password },
  });
  try {
    const created = await api.post("/api/admin/flows", {
      data: { name: `E2E caller ${runId}`, kind: "agent", description: "" },
    });
    expect(created.status()).toBe(201);
    const agent = (await created.json()) as { id: string };
    const nodes = [
      { id: "start", type: "start", position: { x: 0, y: 0 }, data: { title: "Start" } },
      {
        id: "call",
        type: "call_subflow",
        position: { x: 260, y: 0 },
        data: { title: "Call subflow", subflowId: null, inputs: [], outputs: [] },
      },
      {
        id: "reply",
        type: "reply",
        position: { x: 520, y: 0 },
        data: { title: "Reply", template: "{{vars.subflow_result}}" },
      },
      { id: "end", type: "end", position: { x: 780, y: 0 }, data: { title: "End" } },
    ];
    const edges = [
      { id: "e1", source: "start", target: "call", sourceHandle: "out" },
      { id: "e2", source: "call", target: "reply", sourceHandle: "out:result" },
      { id: "e3", source: "reply", target: "end", sourceHandle: "out" },
    ];
    const drafted = await api.put(`/api/admin/flows/${agent.id}/draft`, {
      data: { graph: { nodes, edges } },
    });
    expect(drafted.status()).toBe(200);

    await page.goto(`/chatflows/${agent.id}`);
    await expect(
      page.getByRole("heading", { name: `E2E caller ${runId}`, level: 1 }),
    ).toBeVisible();

    // Pick the subflow and map its required input in the Call Subflow inspector.
    await page.locator('[data-node-type="call_subflow"]').click({ position: { x: 12, y: 12 } });
    await page.getByRole("combobox", { name: "Subflow" }).click();
    await page.getByRole("option", { name: new RegExp(subflowName) }).click();
    await page.getByPlaceholder("Value for topic").fill("Hello {{input.text}}");
    // Outputs auto-sync to the subflow output label; point the Reply at its variable.
    await page.locator('[data-node-type="reply"]').click({ position: { x: 12, y: 12 } });
    await page.getByLabel("Reply template").fill("{{vars.subflow_result}}");

    await page.waitForTimeout(1400);
    await expect(page.getByTestId("save-indicator")).toContainText("Saved");

    await page.getByRole("button", { name: "Publish", exact: true }).click();
    const agentPublish = page.getByRole("dialog");
    await expect(agentPublish.getByText("Validation passed.")).toBeVisible();
    await agentPublish.getByRole("button", { name: "Publish", exact: true }).click();
    await expect(page.getByText("Published version 1")).toBeVisible();

    await page.getByRole("button", { name: "Open test drawer" }).click();
    await page.getByRole("textbox", { name: "Test message" }).fill("world");
    await page.getByRole("button", { name: "Run test message" }).click();
    await expect(page.getByTestId("test-chat")).toContainText("Hello world", { timeout: 20_000 });

    await page.getByRole("button", { name: "Trace" }).first().click();
    const trace = page.getByTestId("test-trace");
    await expect(trace).toContainText("Call subflow", { timeout: 20_000 });
  } finally {
    await api.dispose();
  }
});
