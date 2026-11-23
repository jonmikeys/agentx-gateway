import { expect, test } from "@playwright/test";

const username = process.env.E2E_ADMIN_USERNAME ?? process.env.ADMIN_USERNAME ?? "";
const password = process.env.E2E_ADMIN_PASSWORD ?? process.env.ADMIN_PASSWORD ?? "";

test.describe("API reference without credentials", () => {
  test("the OpenAPI document is public", async ({ request }) => {
    const response = await request.get("/v1/openapi.json");
    expect(response.status()).toBe(200);
    const document = await response.json();
    expect(document.openapi).toBe("3.1.0");
    expect(Object.keys(document.paths)).toContain("/v1/chat/completions");
  });

  test("/docs requires admin authentication", async ({ request }) => {
    const response = await request.get("/docs");
    expect(response.status()).toBe(401);
    expect(response.headers()["www-authenticate"]).toContain("Basic");
  });
});

test.describe("API reference with credentials", () => {
  test.use({ httpCredentials: { username, password } });

  test("renders the Scalar reference without external requests", async ({ page }) => {
    const external: string[] = [];
    const origin = new URL(test.info().project.use.baseURL ?? "http://localhost:3000").origin;
    page.on("request", (request) => {
      const url = request.url();
      if (!url.startsWith(origin) && !url.startsWith("data:") && !url.startsWith("blob:")) {
        external.push(url);
      }
    });

    await page.goto("/docs");
    await expect(page.getByRole("heading", { name: "AGENTX Gateway API", level: 1 })).toBeVisible();
    await expect(page.getByText("Create a chat completion").first()).toBeVisible();
    await page.waitForLoadState("networkidle");
    expect(external).toEqual([]);
  });

  test("is linked from the API Keys page", async ({ page }) => {
    await page.goto("/api-keys");
    const link = page.getByRole("link", { name: "API reference" });
    await expect(link).toHaveAttribute("href", "/docs");
    await expect(link).toHaveAttribute("target", "_blank");
  });
});
