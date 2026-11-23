import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:3000";

/**
 * Smoke tests run against an already running gateway (`pnpm build && pnpm start`).
 * Credentials come from E2E_ADMIN_USERNAME / E2E_ADMIN_PASSWORD, falling back to
 * ADMIN_USERNAME / ADMIN_PASSWORD from the environment.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: { baseURL, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
