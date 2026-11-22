/** Browser-side helper for the admin API (same-origin; the browser supplies Basic credentials). */
export class AdminApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "AdminApiError";
  }
}

export async function adminFetch<T>(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const response = await fetch(`/api/admin/${path}`, {
    method: options.method ?? "GET",
    headers: options.body === undefined ? undefined : { "Content-Type": "application/json" },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    cache: "no-store",
  });
  if (response.status === 204) return undefined as T;
  const json = (await response.json().catch(() => undefined)) as
    | { error?: { code?: string; message?: string; details?: unknown } }
    | undefined;
  if (!response.ok) {
    throw new AdminApiError(
      response.status,
      json?.error?.code ?? "request_failed",
      json?.error?.message ?? `Request failed (HTTP ${response.status})`,
      json?.error?.details,
    );
  }
  return json as T;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong";
}

/** Deterministic UTC timestamp (identical on server and client, so no hydration mismatch). */
export function formatTimestamp(iso: string | null): string {
  if (!iso) return "Never";
  return `${iso.slice(0, 16).replace("T", " ")} UTC`;
}
