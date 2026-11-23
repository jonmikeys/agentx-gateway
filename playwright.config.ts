import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:3000";

/**
 * Smoke tests run against an already running gateway (`pnpm build && pnpm start`).
 * Credentials come from E2E_ADMIN_USERNAME / E2E_ADMIN_PASSWORD, falling back to
 * ADMIN_USERNAME / ADMIN_PASSWORD from the environment.
 */
export default defineConfig({
  testDir: "./e2e",
  // Screenshot capture has its own config: `pnpm screenshots`.
  testIgnore: "screenshots.spec.ts",
  // Seeds the nasty data for e2e/layout.spec.ts once, before any worker starts.
  globalSetup: "./e2e/layout-seed.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  // Every worker shares one `next start` process. Too many parallel workers make server-rendered
  // pages slow enough to trip the default 5 s expect timeout, so cap them instead of raising timeouts.
  workers: process.env.CI ? 2 : 3,
  use: { baseURL, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
