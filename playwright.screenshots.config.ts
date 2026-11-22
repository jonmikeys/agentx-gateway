import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:3000";

/**
 * Captures docs/screenshots (`pnpm screenshots`). Kept out of `pnpm test:e2e`. Run it against a
 * running gateway with a FRESH database, because it seeds demo data and creates an API key:
 *   docker compose -f docker-compose.dev.yml down -v && docker compose -f docker-compose.dev.yml up -d
 *   pnpm build && pnpm start
 *   E2E_ADMIN_USERNAME=<ADMIN_USERNAME> E2E_ADMIN_PASSWORD=<ADMIN_PASSWORD> pnpm screenshots
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: "screenshots.spec.ts",
  workers: 1,
  fullyParallel: false,
  timeout: 120_000,
  reporter: "list",
  use: { baseURL, viewport: { width: 1440, height: 900 } },
  projects: [
    {
      name: "screenshots",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
  ],
});
