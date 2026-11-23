import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

/**
 * G7b slice C end-to-end: sticky notes, visual groups, the hide-annotations toggle, version diff,
 * JSON export and import. Runs against a built app (the starter flow needs no model provider).
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

test("notes, groups, hiding, version diff, export and import", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto("/chatflows");
  await expect(page.getByRole("heading", { name: "Chatflows", level: 1 })).toBeVisible();

  await page.getByRole("button", { name: "New chatflow" }).first().click();
  const flowName = `Extras ${runId}`;
  await page.getByRole("textbox", { name: "Name" }).fill(flowName);
  await page.getByRole("button", { name: "Create chatflow" }).click();
  await expect(page.getByRole("heading", { name: flowName, level: 1 })).toBeVisible();

  // Publish the starter flow so there is a version to compare with later.
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  const publishDialog = page.getByRole("dialog");
  await expect(publishDialog.getByText("Validation passed.")).toBeVisible();
  await publishDialog.getByRole("button", { name: "Publish" }).click();
  await expect(page.getByText("Published version 1")).toBeVisible();
  await page.keyboard.press("Escape");

  // Add a sticky note from the palette and edit its Markdown.
  await page.getByRole("button", { name: "Add Note node" }).click();
  const note = page.locator('[data-node-type="note"]');
  await expect(note).toHaveCount(1);
  await note.dblclick({ position: { x: 20, y: 20 } });
  const noteText = page.getByLabel("Note text");
  await noteText.fill("**Remember** to test the lobby flow.");
  await page.getByRole("heading", { name: flowName, level: 1 }).click();
  await expect(note).toContainText("Remember");

  // Keyboard shortcuts must not fire while typing in an input.
  const noteCountBefore = await note.count();
  await page.getByLabel("Note title").click();
  await page.keyboard.press("n");
  await expect(note).toHaveCount(noteCountBefore);

  // N adds another note when the canvas (not an input) has focus.
  await page.getByRole("heading", { name: flowName, level: 1 }).click();
  await page.keyboard.press("n");
  await expect(note).toHaveCount(noteCountBefore + 1);

  // Group two nodes: select Start, shift-select Reply, then use the toolbar.
  await page.locator('[data-node-type="start"]').click({ position: { x: 10, y: 10 } });
  await page.keyboard.down("Shift");
  await page.locator('[data-node-type="reply"]').click({ position: { x: 10, y: 10 } });
  await page.keyboard.up("Shift");
  await page.getByRole("button", { name: "Group selected nodes" }).click();
  const group = page.locator('[data-node-type="group"]');
  await expect(group).toHaveCount(1);
  await page.getByRole("button", { name: /^Group actions for/ }).click();
  const convert = page.getByRole("menuitem", { name: /Convert group to subflow/ });
  await expect(convert).toBeEnabled();

  // A group that contains the Start node cannot become a subflow.
  await convert.click();
  await expect(page.getByText(/contains a Start node/)).toBeVisible();

  // Ungroup, then wrap just the Reply and convert it into a subflow.
  await page.getByRole("button", { name: "Ungroup selected group" }).click();
  await expect(group).toHaveCount(0);
  await page.locator('[data-node-type="reply"]').click({ position: { x: 10, y: 10 } });
  await page.getByRole("button", { name: "Group selected nodes" }).click();
  await expect(group).toHaveCount(1);
  await page.getByRole("button", { name: /^Group actions for/ }).click();
  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("menuitem", { name: /Convert group to subflow/ }).click();
  const popup = await popupPromise;
  await popup.waitForLoadState();
  await expect(popup.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(popup.getByText("Subflow", { exact: true }).first()).toBeVisible();
  await expect(popup.locator('[data-node-type="subflow_input"]')).toHaveCount(1);
  await expect(popup.locator('[data-node-type="subflow_output"]')).toHaveCount(1);
  await popup.close();

  // The parent now has a Call Subflow node where the group used to be.
  await expect(group).toHaveCount(0);
  await expect(page.locator('[data-node-type="call_subflow"]')).toHaveCount(1);
  await expect(page.getByText("Comparing version with draft")).toHaveCount(0);

  // Keep a group in the draft so the diff and export checks below still cover groups.
  await page.locator('[data-node-type="start"]').click({ position: { x: 10, y: 10 } });
  await page.keyboard.down("Shift");
  await page.locator('[data-node-type="end"]').click({ position: { x: 10, y: 10 } });
  await page.keyboard.up("Shift");
  await page.getByRole("button", { name: "Group selected nodes" }).click();
  await expect(group).toHaveCount(1);

  // Hide notes (and comment badges), then show them again.
  await page.getByRole("button", { name: "Hide notes and comments" }).click();
  await expect(page.locator('[data-node-type="note"]').first()).toBeHidden();
  await page.getByRole("button", { name: "Hide notes and comments" }).click();
  await expect(page.locator('[data-node-type="note"]').first()).toBeVisible();

  // Compare the published version with the draft (added note + group).
  await page.getByRole("button", { name: "Versions", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Version history" })).toBeVisible();
  await page.getByRole("button", { name: "View version 1" }).click();
  await page.getByRole("button", { name: "Compare with draft" }).click();
  const diffPanel = page.getByTestId("version-diff");
  await expect(diffPanel).toBeVisible();
  await expect(diffPanel.getByText("Added nodes")).toBeVisible();
  await expect(diffPanel.getByText(/^Group\b/)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText("Comparing version with draft")).toBeVisible();

  // Export the draft as JSON and read the download.
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export flow as JSON" }).click();
  const download = await downloadPromise;
  const path = await download.path();
  expect(path).toBeTruthy();
  const exported = JSON.parse(readFileSync(path as string, "utf8")) as {
    format: string;
    flow: { name: string };
    graph: { nodes: { type: string }[] };
  };
  expect(exported.format).toBe("agentx.chatflow");
  expect(exported.flow.name).toBe(flowName);
  expect(exported.graph.nodes.some((node) => node.type === "note")).toBe(true);
  expect(exported.graph.nodes.some((node) => node.type === "group")).toBe(true);

  // Import the exported JSON from the list page; it creates a new flow.
  await page.goto("/chatflows");
  await page.getByRole("button", { name: "Import JSON" }).click();
  await page.getByLabel("Imported chatflow JSON").fill(JSON.stringify(exported));
  await page.getByRole("button", { name: "Import chatflow" }).click();
  await expect(page.getByRole("heading", { name: flowName, level: 1 })).toBeVisible();
  await expect(page.locator('[data-node-type="note"]')).toHaveCount(2);
  await expect(page.locator('[data-node-type="group"]')).toHaveCount(1);
});
