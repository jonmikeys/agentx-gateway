import AxeBuilder from "@axe-core/playwright";
import { type APIRequestContext, expect, type Page, request, test } from "@playwright/test";
import { allPages } from "../src/components/app-shell/nav";
import { type MockUpstream, startMockUpstream } from "../tests/support/mock-upstream";

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

const providerNames = {
  long: "Layout QA provider with an extremely long display name that keeps going 123",
  short: "Layout QA mock",
};
const longBaseUrlPath = `/v1/${"a".repeat(120)}`;
const routeSlug = "layout-qa-route-with-a-very-long-slug-for-checking-layout-1234";
const runId = Date.now().toString(36);
const keyLabel = "Layout QA key \u{1F680} with a long label that keeps going and going on";

let upstream: MockUpstream;

async function seed(admin: APIRequestContext) {
  const list = async (collection: string) =>
    ((await (await admin.get(`/api/admin/${collection}`)).json()).data ?? []) as Record<
      string,
      string
    >[];
  const ids: Record<string, string> = {};
  const providers = [
    { name: providerNames.long, base_url: `${upstream.url}${longBaseUrlPath}` },
    { name: providerNames.short, base_url: upstream.url },
  ];
  for (const { name, base_url } of providers) {
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
      data: { name, base_url, api_key: "sk-layout-qa-not-a-real-key" },
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

test.beforeAll(async ({ baseURL }) => {
  upstream = await startMockUpstream({ models: ["ok", "mock-model"] });
  const admin = await request.newContext({
    baseURL,
    httpCredentials: { username, password },
  });
  try {
    await seed(admin);
  } finally {
    await admin.dispose();
  }
});

test.afterAll(async () => {
  await upstream.close();
});

test.use({ httpCredentials: { username, password } });
// Sequential: the tests share seeded rows and create API keys.
test.describe.configure({ mode: "default" });

async function openPage(page: Page, href: string) {
  await page.goto(href);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.waitForLoadState("networkidle");
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
