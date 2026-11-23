import { expect, test } from "@playwright/test";

/**
 * G7a end-to-end: create a chatflow in the editor, change its Reply template, publish it, run a
 * test message in the drawer and inspect the per-node trace. Runs against a built app with the
 * layout seed's provider/route data (the Reply-only flow needs no model).
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

test("build, publish and test a chatflow", async ({ page }) => {
  await page.goto("/chatflows");
  await expect(page.getByRole("heading", { name: "Chatflows", level: 1 })).toBeVisible();

  await page.getByRole("button", { name: "New chatflow" }).first().click();
  await page.getByRole("textbox", { name: "Name" }).fill(`E2E greeter ${runId}`);
  await page.getByRole("button", { name: "Create chatflow" }).click();
  await expect(page.getByRole("heading", { name: `E2E greeter ${runId}`, level: 1 })).toBeVisible();

  // The starter flow is Start -> Reply -> End; make the reply use the user's text.
  await page.locator('[data-node-type="reply"]').click({ position: { x: 12, y: 12 } });
  const template = page.getByLabel("Reply template");
  await expect(template).toBeVisible();
  await template.fill("Hello {{input.text}}");
  // Autosave is debounced; wait for the saved indicator before publishing.
  await page.waitForTimeout(1400);
  await expect(page.getByTestId("save-indicator")).toContainText("Saved");

  await page.getByRole("button", { name: "Publish", exact: true }).click();
  const publishDialog = page.getByRole("dialog");
  await expect(publishDialog.getByText("Validation passed.")).toBeVisible();
  await publishDialog.getByLabel("Version note").fill("First version");
  await publishDialog.getByRole("button", { name: "Publish" }).click();
  await expect(page.getByText("Published version 1")).toBeVisible();

  // Test drawer: run a message and inspect the trace.
  await page.getByRole("button", { name: "Open test drawer" }).click();
  await page.getByRole("textbox", { name: "Test message" }).fill("world");
  await page.getByRole("button", { name: "Run test message" }).click();
  const chat = page.getByTestId("test-chat");
  await expect(chat).toContainText("Hello world", { timeout: 20_000 });

  await page.getByRole("button", { name: "Trace" }).first().click();
  const trace = page.getByTestId("test-trace");
  await expect(trace).toContainText("Reply", { timeout: 20_000 });
  await expect(trace).toContainText("Start");
  await expect(trace).toContainText("End");

  await page.getByRole("button", { name: "Highlight Reply step" }).click();
  await expect(page.locator('[data-node-type="reply"]')).toHaveClass(/ring-2/);
});
