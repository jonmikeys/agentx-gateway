import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { allPages } from "../src/components/app-shell/nav";
import { makePng } from "../tests/support/media-files";
import {
  AGENT_FLOW_NAME,
  cameraNames,
  keyLabel,
  mcpServerName,
  mediaNames,
  providerNames,
  routeSlug,
  type SessionIds,
  SUBFLOW_FLOW_ENV,
  subflowNames,
} from "./layout-seed";

/**
 * Layout guards (docs/ui-qa.md): for every page in nav.ts and the key dialogs, at desktop and
 * 390 px mobile widths, assert no horizontal page scroll, no content sticking out of an open
 * dialog, named buttons and links, focus returning to the opener, and no serious or critical axe
 * violations. Seeds deliberately nasty data (long names and URLs, a 10-step route, an emoji label).
 */
const username = process.env.E2E_ADMIN_USERNAME ?? process.env.ADMIN_USERNAME ?? "";
const password = process.env.E2E_ADMIN_PASSWORD ?? process.env.ADMIN_PASSWORD ?? "";

const viewports = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
] as const;
const themes = ["light", "dark"] as const;

const runId = Date.now().toString(36);

const sessionIds = JSON.parse(process.env.LAYOUT_QA_SESSION_IDS ?? "{}") as SessionIds;
const agentFlowId = process.env.LAYOUT_QA_FLOW_ID ?? "";
const clientFlowId = process.env.LAYOUT_QA_CLIENT_FLOW_ID ?? "";
const subflowFlowId = process.env[SUBFLOW_FLOW_ENV] ?? "";

// Reduced motion: dialogs fade in, and axe would sample half-transparent text mid-animation.
test.use({ httpCredentials: { username, password }, reducedMotion: "reduce" });
// Sequential: the tests share seeded rows and create API keys.
test.describe.configure({ mode: "default" });

async function openPage(page: Page, href: string) {
  await page.goto(href);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.waitForLoadState("networkidle");
  await expectNoMojibake(page);
}

/** No rendered text may contain the replacement character or Shift-JIS mojibake. */
async function expectNoMojibake(page: Page) {
  const text = (await page.locator("body").textContent()) ?? "";
  const found = text.match(/[\uFFFD\uFF82\uFF77\uFF67]/);
  expect(found?.[0] ?? null, "rendered mojibake or replacement character").toBeNull();
}

async function expectNoHorizontalScroll(page: Page) {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(scrollWidth, "page scrolls horizontally").toBeLessThanOrEqual(innerWidth);
}

/** Every button and link in the accessibility tree must have a name. */
async function expectNamedControls(page: Page) {
  const snapshot = await page.locator("body").ariaSnapshot();
  const unnamed = snapshot
    .split("\n")
    .filter((line) => /^\s*- (button|link)(\s+\[[^\]]*\])*:?\s*$/.test(line));
  expect(unnamed, "buttons or links without an accessible name").toEqual([]);
}

async function expectNoSeriousAxeViolations(page: Page, scope?: string) {
  const builder = new AxeBuilder({ page });
  if (scope) builder.include(scope);
  const { violations } = await builder.analyze();
  const blocking = violations
    .filter((violation) => violation.impact === "serious" || violation.impact === "critical")
    .map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      targets: violation.nodes.slice(0, 3).map((node) => node.target.join(" ")),
    }));
  expect(blocking, "serious or critical axe violations").toEqual([]);
}

/** No visible descendant of the open dialog may extend past the dialog's own box. */
async function expectDialogContained(page: Page) {
  const dialog = page.locator('[role="dialog"], [role="alertdialog"]').last();
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("data-state", "open");
  const overflowing = await dialog.evaluate((root) => {
    const box = root.getBoundingClientRect();
    const tolerance = 1;
    const found: string[] = [];
    for (const element of root.querySelectorAll("*")) {
      if (element.closest('[aria-hidden="true"]')) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.right > box.right + tolerance || rect.left < box.left - tolerance) {
        found.push(
          `${element.tagName.toLowerCase()}[${element.getAttribute("data-slot") ?? element.className}] left=${Math.round(rect.left - box.left)} right=${Math.round(rect.right - box.right)}`,
        );
      }
    }
    return found.slice(0, 5);
  });
  expect(overflowing, "elements overflow the dialog").toEqual([]);
  await expectNoHorizontalScroll(page);
}

for (const viewport of viewports) {
  test.describe(`${viewport.name} ${viewport.width}px`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    for (const navPage of allPages) {
      test(`page ${navPage.title}: no horizontal scroll, named controls`, async ({ page }) => {
        await openPage(page, navPage.href);
        await expectNoHorizontalScroll(page);
        await expectNamedControls(page);
      });

      for (const theme of themes) {
        test(`page ${navPage.title}: axe, ${theme} theme`, async ({ page }) => {
          await page.addInitScript((value) => {
            window.localStorage.setItem("theme", value);
          }, theme);
          await openPage(page, navPage.href);
          await expectNoSeriousAxeViolations(page);
        });
      }
    }

    test("provider dialogs stay inside the dialog and return focus", async ({ page }) => {
      await openPage(page, "/providers");
      const newButton = page.getByRole("button", { name: "New provider" });
      await newButton.click();
      await expectDialogContained(page);
      await expectNoSeriousAxeViolations(page, '[role="dialog"]');
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(newButton).toBeFocused();

      const edit = page.getByRole("button", { name: `Edit ${providerNames.long}` });
      await edit.click();
      await expectDialogContained(page);
      await page.keyboard.press("Escape");
      await expect(edit).toBeFocused();

      const testConnection = page
        .getByRole("row", { name: new RegExp(providerNames.short) })
        .getByRole("button", { name: "Test connection" });
      await testConnection.click();
      await expect(page.getByRole("heading", { name: "Connection succeeded" })).toBeVisible();
      await expectDialogContained(page);
      await page.keyboard.press("Escape");
      await expect(testConnection).toBeFocused();

      const remove = page.getByRole("button", { name: `Delete ${providerNames.long}` });
      await remove.click();
      await expectDialogContained(page);
      await page.keyboard.press("Escape");
      await expect(remove).toBeFocused();
    });

    test("MCP server dialogs stay inside the dialog and return focus", async ({ page }) => {
      await openPage(page, "/mcp");
      await expectNoHorizontalScroll(page);

      const newServer = page.getByRole("button", { name: "New MCP server" });
      await newServer.click();
      await expectDialogContained(page);
      await expectNoSeriousAxeViolations(page, '[role="dialog"]');
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(newServer).toBeFocused();

      const edit = page.getByRole("button", { name: `Edit ${mcpServerName}` });
      await edit.click();
      await expectDialogContained(page);
      await expectNoSeriousAxeViolations(page, '[role="dialog"]');
      await page.keyboard.press("Escape");
      await expect(edit).toBeFocused();

      const row = page.getByRole("row", { name: new RegExp(mcpServerName) });
      const testConnection = row.getByRole("button", { name: "Test" });
      await testConnection.click();
      await expect(page.getByRole("heading", { name: "Connection succeeded" })).toBeVisible();
      await expectDialogContained(page);
      await page.keyboard.press("Escape");
      await expect(testConnection).toBeFocused();

      const browse = page.getByRole("button", { name: `Browse tools for ${mcpServerName}` });
      await browse.click();
      await expect(page.getByRole("heading", { name: new RegExp(mcpServerName) })).toBeVisible();
      await page.getByRole("button", { name: "Schema preview" }).first().click();
      await expectDialogContained(page);
      await expectNoSeriousAxeViolations(page, '[role="dialog"]');
      await page.keyboard.press("Escape");
      await expect(browse).toBeFocused();

      const remove = page.getByRole("button", { name: `Delete ${mcpServerName}` });
      await remove.click();
      await expectDialogContained(page);
      await page.keyboard.press("Escape");
      await expect(remove).toBeFocused();
    });

    test("route editor with ten long steps stays inside the dialog", async ({ page }) => {
      await openPage(page, "/routes");
      const edit = page.getByRole("button", { name: `Edit ${routeSlug}` });
      await edit.click();
      await expect(page.getByRole("button", { name: "Move step 10 up" })).toBeAttached();
      await expectDialogContained(page);
      await expectNoSeriousAxeViolations(page, '[role="dialog"]');
      await page.keyboard.press("Escape");
      await expect(edit).toBeFocused();

      const create = page.getByRole("button", { name: "New route" });
      await create.click();
      await expectDialogContained(page);
      await page.keyboard.press("Escape");
      await expect(create).toBeFocused();
    });

    test("API key dialogs stay inside the dialog", async ({ page }) => {
      await openPage(page, "/api-keys");
      const create = page.getByRole("button", { name: "New API key" });
      await create.click();
      await expectDialogContained(page);
      await page.keyboard.press("Escape");
      await expect(create).toBeFocused();

      const edit = page.getByRole("button", { name: `Edit ${keyLabel}`, exact: true });
      await edit.click();
      await expectDialogContained(page);
      await page.keyboard.press("Escape");
      await expect(edit).toBeFocused();

      const createdKeyLabel = `Layout QA ${viewport.name} ${runId}`;
      await create.click();
      await page.getByRole("textbox", { name: "Label" }).fill(`${createdKeyLabel}`);
      await page.getByRole("button", { name: "Create key" }).click();
      await expect(page.getByText("won't be shown again")).toBeVisible();
      // Only the "created" dialog may be open: the create form must have closed.
      await expect(page.getByRole("dialog")).toHaveCount(1);
      await expectDialogContained(page);
      await expectNoSeriousAxeViolations(page, '[role="dialog"]');
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(create).toBeFocused();

      const revoke = page
        .getByRole("row", { name: new RegExp(createdKeyLabel) })
        .getByRole("button", { name: "Revoke" });
      await revoke.click();
      await expectDialogContained(page);
      await page.keyboard.press("Escape");
      await expect(revoke).toBeFocused();
    });

    test("sessions list: bulk delete confirmation stays inside the dialog", async ({ page }) => {
      await openPage(page, "/sessions");
      await expect(page.getByRole("link", { name: /UTC$/ }).first()).toBeVisible();
      const boxes = page.getByRole("checkbox", { name: /^Select session/ });
      await boxes.nth(0).click();
      await boxes.nth(1).click();
      const bulkDelete = page.getByRole("button", { name: /^Delete 2/ });
      await bulkDelete.click();
      await expectDialogContained(page);
      await expectNoSeriousAxeViolations(page, '[role="alertdialog"]');
      await page.keyboard.press("Escape");
      await expect(page.getByRole("alertdialog")).toHaveCount(0);
      await expect(bulkDelete).toBeFocused();
    });

    test("sessions list: search, standalone toggle and sort keep the page inside the viewport", async ({
      page,
    }) => {
      await openPage(page, "/sessions");
      await page.getByLabel("Search transcripts").fill("x".repeat(60));
      await expectNoHorizontalScroll(page);
      await page.getByLabel("Include standalone").click();
      await expectNoHorizontalScroll(page);
      await expectNamedControls(page);
    });

    for (const scenario of ["chat", "reasoning", "tools", "ended", "responses"] as const) {
      for (const theme of themes) {
        test(`transcript (${scenario}): layout and axe, ${theme} theme`, async ({ page }) => {
          await page.addInitScript((value) => {
            window.localStorage.setItem("theme", value);
          }, theme);
          await openPage(page, `/sessions/${sessionIds[scenario]}`);
          for (const trigger of await page.getByRole("button", { name: /^Thinking/ }).all()) {
            await trigger.click();
          }
          const systemPrompt = page.getByRole("button", { name: /^System prompt/ });
          if (await systemPrompt.count()) await systemPrompt.click();
          await expectNoHorizontalScroll(page);
          await expectNamedControls(page);
          await expectNoSeriousAxeViolations(page);
          if (scenario === "responses") {
            const badges = page.getByTestId("api-badge");
            await expect(badges.first()).toHaveText("responses → chat");
            await expect(badges.last()).toHaveText("responses → responses");
          }
          if (scenario === "ended") {
            await expect(page.getByRole("button", { name: "End session" })).toBeDisabled();
            await expect(page.getByTestId("live-indicator")).toHaveCount(0);
          } else {
            await expect(page.getByTestId("live-indicator")).toBeVisible();
          }
        });
      }
    }

    test("transcript: failover popover stays inside the viewport", async ({ page }) => {
      await openPage(page, `/sessions/${sessionIds.chat}`);
      const trigger = page.getByRole("button", { name: "2 attempts" }).first();
      await trigger.click();
      const popover = page.getByText("Failover attempts");
      await expect(popover).toBeVisible();
      const box = await page.locator('[data-slot="popover-content"]').boundingBox();
      expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(viewport.width);
      await expectNoSeriousAxeViolations(page, '[data-slot="popover-content"]');
      await page.keyboard.press("Escape");
      await expect(popover).toHaveCount(0);
      await expect(trigger).toBeFocused();
    });

    test("transcript: end and delete confirmations stay inside the dialog", async ({ page }) => {
      await openPage(page, `/sessions/${sessionIds.reasoning}`);
      const end = page.getByRole("button", { name: "End session" });
      await end.click();
      await expectDialogContained(page);
      await page.keyboard.press("Escape");
      await expect(end).toBeFocused();

      const remove = page.getByRole("button", { name: "Delete", exact: true });
      await remove.click();
      await expectDialogContained(page);
      await page.keyboard.press("Escape");
      await expect(remove).toBeFocused();
    });

    test("media: upload, external URL, edit and preview dialogs stay inside the dialog", async ({
      page,
    }) => {
      await openPage(page, "/media");
      await expectNoHorizontalScroll(page);
      const upload = page.getByRole("button", { name: "Upload media" }).first();
      await upload.click();
      await expectDialogContained(page);
      await page.getByTestId("media-file-input").setInputFiles({
        name: `${"very-long-file-name-".repeat(8)}.png`,
        mimeType: "image/png",
        buffer: makePng(8, 8, [1, 2, 3]),
      });
      await page.getByLabel("Tags for these files").fill(`long-tag-${"z".repeat(22)}`);
      await page.keyboard.press("Enter");
      await expectDialogContained(page);
      await expectNoSeriousAxeViolations(page, '[role="dialog"]');
      await page.keyboard.press("Escape");
      await expect(upload).toBeFocused();

      const external = page.getByRole("button", { name: "Add external URL" }).first();
      await external.click();
      await expectDialogContained(page);
      await expectNoSeriousAxeViolations(page, '[role="dialog"]');
      await page.keyboard.press("Escape");
      await expect(external).toBeFocused();

      const edit = page.getByRole("button", { name: `Edit ${mediaNames.long}`, exact: true });
      await edit.click();
      await expectDialogContained(page);
      await expectNoSeriousAxeViolations(page, '[role="dialog"]');
      await page.keyboard.press("Escape");
      await expect(edit).toBeFocused();

      const preview = page.getByRole("button", { name: `Preview ${mediaNames.long}`, exact: true });
      await preview.click();
      await expectDialogContained(page);
      await page.keyboard.press("Escape");
      await expect(preview).toBeFocused();

      const remove = page.getByRole("button", { name: `Delete ${mediaNames.long}`, exact: true });
      await remove.click();
      await expectDialogContained(page);
      await page.keyboard.press("Escape");
      await expect(remove).toBeFocused();
    });

    test("media: cards truncate long names and tags inside the grid", async ({ page }) => {
      await openPage(page, "/media");
      await expectNamedControls(page);
      const overflowing = await page
        .getByTestId("media-card")
        .evaluateAll((cards) =>
          cards
            .filter((card) => card.scrollWidth > card.clientWidth + 1)
            .map((card) => card.textContent),
        );
      expect(overflowing, "cards wider than the grid cell").toEqual([]);
    });

    test("cameras: form, test result, preview and delete dialogs stay inside the dialog", async ({
      page,
    }) => {
      await openPage(page, "/cameras");
      await expectNoHorizontalScroll(page);
      const create = page.getByRole("button", { name: "New camera" });
      await create.click();
      await expectDialogContained(page);
      await expectNoSeriousAxeViolations(page, '[role="dialog"]');
      // The type-specific fields differ per type; both must fit.
      await page.getByRole("combobox", { name: /type/i }).click();
      await page.getByRole("option", { name: /look-at/i }).click();
      await expectDialogContained(page);
      await page.keyboard.press("Escape");
      await expect(create).toBeFocused();

      const edit = page.getByRole("button", { name: `Edit ${cameraNames.good}`, exact: true });
      await edit.click();
      await expectDialogContained(page);
      await page.keyboard.press("Escape");
      await expect(edit).toBeFocused();

      const test_ = page.getByRole("button", { name: `Test ${cameraNames.good}`, exact: true });
      await test_.click();
      await expect(page.getByRole("heading", { name: "Camera test passed" })).toBeVisible();
      await expectDialogContained(page);
      await expectNoSeriousAxeViolations(page, '[role="dialog"]');
      await page.keyboard.press("Escape");
      await expect(test_).toBeFocused();

      const failing = page.getByRole("button", {
        name: `Test ${cameraNames.unreachable}`,
        exact: true,
      });
      await failing.click();
      await expect(page.getByRole("heading", { name: /Camera test failed/ })).toBeVisible();
      await expectDialogContained(page);
      await page.keyboard.press("Escape");
      await expect(failing).toBeFocused();

      const preview = page.getByRole("button", {
        name: `Preview ${cameraNames.good}`,
        exact: true,
      });
      await preview.click();
      await expectDialogContained(page);
      await page.keyboard.press("Escape");
      await expect(preview).toBeFocused();

      const remove = page.getByRole("button", { name: `Delete ${cameraNames.good}`, exact: true });
      await remove.click();
      await expectDialogContained(page);
      await page.keyboard.press("Escape");
      await expect(remove).toBeFocused();
    });

    test("chatflows: Agents / Subflows filter narrows the list", async ({ page }) => {
      await openPage(page, "/chatflows");
      const filter = page.getByRole("group", { name: "Filter by kind" });
      const subflowsFilter = filter.getByRole("button", { name: /^Subflows/ });
      const agentsFilter = filter.getByRole("button", { name: /^Agents/ });
      await subflowsFilter.click();
      await expect(subflowsFilter).toHaveAttribute("aria-pressed", "true");
      await expect(page.getByText(subflowNames.caller).first()).toBeVisible();
      await expect(page.getByText(AGENT_FLOW_NAME).first()).toHaveCount(0);
      await expectNoHorizontalScroll(page);
      await agentsFilter.click();
      await expect(agentsFilter).toHaveAttribute("aria-pressed", "true");
      await expect(page.getByText(AGENT_FLOW_NAME).first()).toBeVisible();
      await expect(page.getByText(subflowNames.caller).first()).toHaveCount(0);
      await expectNamedControls(page);
    });

    test("subflow editor: Input, Output and Call Subflow property panels", async ({ page }) => {
      if (viewport.width < 1024) return;
      await openPage(page, `/chatflows/${subflowFlowId}`);
      await expect(page.getByText("Subflow", { exact: true }).first()).toBeVisible();
      await expectNoHorizontalScroll(page);
      await expectNamedControls(page);

      await page.locator('[data-node-type="subflow_input"]').click({ position: { x: 12, y: 12 } });
      await expect(page.getByText("Parameters", { exact: true })).toBeVisible();

      await page.locator('[data-node-type="subflow_output"]').click({ position: { x: 12, y: 12 } });
      await expect(page.getByLabel("Branch label")).toBeVisible();

      await page.locator('[data-node-type="call_subflow"]').click({ position: { x: 12, y: 12 } });
      await expect(page.getByRole("combobox", { name: "Subflow" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Sync outputs" })).toBeVisible();
      await expectNoSeriousAxeViolations(page);
    });

    test("chatflow editor: layout, dialogs and test drawer", async ({ page }) => {
      test.setTimeout(60_000);
      await openPage(page, `/chatflows/${agentFlowId}`);
      await expectNoHorizontalScroll(page);
      await expectNamedControls(page);

      for (const name of [
        "Group selected nodes",
        "Ungroup selected group",
        "Hide notes and comments",
        "Fit view",
        "Export flow as JSON",
      ]) {
        await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
      }

      await test.step("node comment popover", async () => {
        // Start node carries a comment in the seed. Dispatch the click so the narrow mobile
        // viewport (where the node can sit partly outside the canvas) still opens the popover.
        const comment = page.getByRole("button", { name: "Show comment" }).first();
        await comment.evaluate((element) => (element as HTMLElement).click());
        await expect(page.getByText(/Last edited/)).toBeVisible();
        if (viewport.name === "desktop") {
          const popover = await page.locator('[data-slot="popover-content"]').boundingBox();
          expect(popover?.x ?? -1).toBeGreaterThanOrEqual(0);
          expect((popover?.x ?? 0) + (popover?.width ?? 0)).toBeLessThanOrEqual(viewport.width + 1);
        }
        await expectNoSeriousAxeViolations(page, '[data-slot="popover-content"]');
        await page.keyboard.press("Escape");
        await expect(comment).toBeFocused();
      });

      const settings = page.getByRole("button", { name: "Settings", exact: true });
      await settings.click();
      await expect(page.getByLabel("Name")).toBeVisible();
      await expect(page.getByLabel("Allowed media tags")).toBeVisible();
      await expect(page.getByText("Allowed cameras", { exact: true })).toBeVisible();
      await expectNoHorizontalScroll(page);
      await expectNamedControls(page);
      await settings.click();

      await test.step("publish dialog", async () => {
        const publish = page.getByRole("button", { name: "Publish", exact: true });
        await publish.click();
        await expect(page.getByText("Validation passed.")).toBeVisible();
        await expectNoMojibake(page);
        await expectDialogContained(page);
        await expectNoSeriousAxeViolations(page, '[role="dialog"]');
        await page.keyboard.press("Escape");
        await expect(page.getByRole("dialog")).toHaveCount(0);
        await expect(publish).toBeFocused();
      });

      await test.step("version diff", async () => {
        const versions = page.getByRole("button", { name: "Versions", exact: true });
        await versions.click();
        await expect(page.getByRole("heading", { name: "Version history" })).toBeVisible();
        await page
          .getByRole("button", { name: /^View version/ })
          .first()
          .click();
        await page.getByRole("button", { name: "Compare with draft" }).click();
        await expect(page.getByTestId("version-diff")).toBeVisible();
        await expectDialogContained(page);
        await expectNoSeriousAxeViolations(page, '[role="dialog"]');
        await page.keyboard.press("Escape");
        await expect(versions).toBeFocused();
      });

      await test.step("hide annotations toggle", async () => {
        const hide = page.getByRole("button", { name: "Hide notes and comments" });
        await hide.click();
        await expect(hide).toHaveAttribute("aria-pressed", "true");
        await hide.click();
        await expect(hide).toHaveAttribute("aria-pressed", "false");
      });

      await test.step("settings view", async () => {
        const settings = page.getByRole("button", { name: "Settings", exact: true });
        await settings.click();
        await expect(page.getByLabel("Name")).toBeVisible();
        await expectNoHorizontalScroll(page);
        await expectNamedControls(page);
        await settings.click();
      });

      await test.step("test drawer", async () => {
        const openDrawer = page.getByRole("button", { name: "Open test drawer" });
        await openDrawer.click();
        await expect(page.getByRole("textbox", { name: "Test message" })).toBeVisible();
        await expectNoMojibake(page);
        await expectNoHorizontalScroll(page);
        await expectNamedControls(page);
        await page.getByRole("button", { name: "Close test drawer" }).click();
      });
    });

    test("chatflow editor: Client Action media picker fits the properties panel", async ({
      page,
    }) => {
      await openPage(page, `/chatflows/${clientFlowId}`);
      await page.locator('[data-node-type="client_action"]').click({ position: { x: 12, y: 12 } });
      if (viewport.name === "mobile") {
        await page.getByRole("button", { name: "Properties" }).click();
      }
      const media = page.getByLabel("Media item");
      const mediaPicker = viewport.name === "mobile" ? media.last() : media.first();
      await expect(mediaPicker).toBeVisible();
      await mediaPicker.click();
      await page.getByRole("option").first().click();
      const args = page.getByLabel("Arguments (JSON, templates allowed)");
      const argsEditor = viewport.name === "mobile" ? args.last() : args.first();
      await expect(argsEditor).toHaveValue(/media_id/);
      await expectNoHorizontalScroll(page);
      await expectNamedControls(page);
      await expectNoSeriousAxeViolations(page);
      if (viewport.name === "mobile") await page.keyboard.press("Escape");
    });

    for (const theme of themes) {
      test(`chatflow editor: axe, ${theme} theme`, async ({ page }) => {
        await page.addInitScript((value) => {
          window.localStorage.setItem("theme", value);
        }, theme);
        await openPage(page, `/chatflows/${agentFlowId}`);
        await expectNoSeriousAxeViolations(page);
      });
    }
    test("chatflow import dialog stays inside the dialog", async ({ page }) => {
      await openPage(page, "/chatflows");
      const importButton = page.getByRole("button", { name: "Import JSON" });
      await importButton.click();
      await expect(page.getByRole("heading", { name: "Import chatflow JSON" })).toBeVisible();
      await expectDialogContained(page);
      await expectNoSeriousAxeViolations(page, '[role="dialog"]');
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(importButton).toBeFocused();
    });

    test("command palette stays inside the dialog", async ({ page }) => {
      await openPage(page, "/");
      await page.getByRole("button", { name: /Search pages/ }).click();
      await expect(page.getByPlaceholder("Go to page...")).toBeVisible();
      await expectDialogContained(page);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
    });
  });
}
