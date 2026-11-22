import { sql } from "drizzle-orm";
import { closeDatabase, getDb } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { resetEnvCacheForTests } from "@/server/env";
import { circuitBreaker } from "@/server/gateway/circuit-breaker";
import { invalidateApiKeyCache } from "@/server/gateway/client-auth-cache";
import { createApiKey } from "@/server/services/api-keys";
import { createProvider } from "@/server/services/providers";
import { createRoute } from "@/server/services/routes";
import { resetSessionSettingsCacheForTests } from "@/server/services/session-settings";

export const ADMIN_USERNAME = "admin";
export const ADMIN_PASSWORD = "secret";

export function setTestEnv(databaseUrl: string): void {
  process.env.DATABASE_URL = databaseUrl;
  process.env.GATEWAY_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  process.env.ADMIN_USERNAME = ADMIN_USERNAME;
  process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;
  process.env.LOG_LEVEL = "error";
  resetEnvCacheForTests();
}

export async function prepareDatabase(databaseUrl: string): Promise<void> {
  setTestEnv(databaseUrl);
  await closeDatabase();
  await runMigrations(databaseUrl);
}

/** Empties every G2 table and resets in-process state (breaker, key cache). */
export async function resetGatewayState(): Promise<void> {
  await getDb().execute(
    sql`truncate table settings, sessions, llm_requests, rate_counters, route_steps, model_routes, api_keys, providers cascade`,
  );
  circuitBreaker.reset();
  resetSessionSettingsCacheForTests();
  invalidateApiKeyCache();
}

export function adminHeaders(): Record<string, string> {
  const token = Buffer.from(`${ADMIN_USERNAME}:${ADMIN_PASSWORD}`).toString("base64");
  return { Authorization: `Basic ${token}`, "Content-Type": "application/json" };
}

export async function seedProvider(name: string, baseUrl: string, apiKey: string | null = null) {
  return createProvider({
    name,
    base_url: baseUrl,
    api_key: apiKey,
    enabled: true,
    capabilities: { streaming: true, tools: true, responses_api: false },
    extra_headers: null,
  });
}

export interface SeedStep {
  providerId: string;
  model: string;
  timeoutMs?: number;
}

export async function seedRoute(slug: string, steps: SeedStep[], enabled = true) {
  return createRoute({
    slug,
    description: "",
    enabled,
    steps: steps.map((step) => ({
      provider_id: step.providerId,
      upstream_model: step.model,
      timeout_ms: step.timeoutMs ?? 5000,
    })),
  });
}

export async function seedApiKey(
  overrides: {
    ip_allowlist?: string[];
    rpm_limit?: number | null;
    tokens_per_day_limit?: number | null;
  } = {},
) {
  return createApiKey({
    label: "test",
    ip_allowlist: overrides.ip_allowlist ?? [],
    rpm_limit: overrides.rpm_limit ?? null,
    tokens_per_day_limit: overrides.tokens_per_day_limit ?? null,
  });
}

export async function waitFor<T>(read: () => Promise<T | undefined>, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
