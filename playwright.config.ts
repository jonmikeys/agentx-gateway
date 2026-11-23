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
  // The whole suite shares one `next start` process; server components can take longer than the
  // 5 s default to render while the heavy layout spec runs alongside. This is a wait ceiling,
  // not an assertion that things must be slow.
  expect: { timeout: 15_000 },
  use: { baseURL, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
