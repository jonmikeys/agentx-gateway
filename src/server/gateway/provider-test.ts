import type { ProviderRuntime } from "@/server/services/providers";

export interface ProviderTestResult {
  ok: boolean;
  latency_ms: number;
  model_count: number | null;
  models: string[];
  error: string | null;
}

const TEST_TIMEOUT_MS = 5000;
const MAX_MODELS_RETURNED = 500;

/** Calls `{base_url}/models` with a 5 s timeout and reports reachability, latency and model ids. */
export async function testProviderConnection(
  provider: ProviderRuntime,
  fetchImpl: typeof fetch = fetch,
): Promise<ProviderTestResult> {
  const started = performance.now();
  const headers = new Headers({ Accept: "application/json" });
  if (provider.apiKey) headers.set("Authorization", `Bearer ${provider.apiKey}`);
  for (const [name, value] of Object.entries(provider.extraHeaders)) headers.set(name, value);

  const result = (partial: Partial<ProviderTestResult>): ProviderTestResult => ({
    ok: false,
    latency_ms: Math.round(performance.now() - started),
    model_count: null,
    models: [],
    error: null,
    ...partial,
  });

  try {
    const response = await fetchImpl(`${provider.baseUrl}/models`, {
      headers,
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    });
    if (!response.ok) return result({ error: `HTTP ${response.status}` });
    const body = (await response.json()) as { data?: { id?: unknown }[] };
    const models = (Array.isArray(body.data) ? body.data : [])
      .map((entry) => entry.id)
      .filter((id): id is string => typeof id === "string");
    return result({
      ok: true,
      model_count: models.length,
      models: models.slice(0, MAX_MODELS_RETURNED),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "TimeoutError") return result({ error: "Timed out after 5 s" });
    if (error instanceof SyntaxError) return result({ error: "Response was not valid JSON" });
    return result({ error: "Could not connect to the provider" });
  }
}
