import { expect, test } from "@playwright/test";

const username = process.env.E2E_ADMIN_USERNAME ?? process.env.ADMIN_USERNAME ?? "";
const password = process.env.E2E_ADMIN_PASSWORD ?? process.env.ADMIN_PASSWORD ?? "";

test.describe("without credentials", () => {
  test("CRM requires authentication", async ({ request }) => {
    const response = await request.get("/");
    expect(response.status()).toBe(401);
    expect(response.headers()["www-authenticate"]).toContain("Basic");
  });

  test("health is public", async ({ request }) => {
    const response = await request.get("/health");
    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, db: true });
  });
});

test.describe("with credentials", () => {
  test.use({ httpCredentials: { username, password } });

  test("shows sidebar groups and navigates to Sessions", async ({ page }) => {
    await page.goto("/");
    for (const group of [
      "Overview",
      "Conversations",
      "Agents",
      "Media Content",
      "Models & Integrations",
      "Administration",
    ]) {
      await expect(page.getByRole("button", { name: group })).toBeVisible();
    }

    await page.getByRole("link", { name: "Sessions" }).click();
    await expect(page).toHaveURL(/\/sessions$/);
    await expect(page.getByRole("heading", { name: "Sessions" })).toBeVisible();
    await expect(page.getByText("Coming in G3")).toBeVisible();
  });

  test("opens the command palette with Ctrl+K", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Open command palette" })).toBeVisible();
    // Wait for hydration before using the keyboard shortcut.
    await page.waitForLoadState("networkidle");
    await page.keyboard.press("Control+k");
    await expect(page.getByPlaceholder("Go to page...")).toBeVisible();
    await page.getByRole("option", { name: "Settings" }).click();
    await expect(page).toHaveURL(/\/settings$/);
  });

  test("admin API answers for authenticated users", async ({ request }) => {
    const response = await request.get("/api/admin/me");
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ username });
  });
});
