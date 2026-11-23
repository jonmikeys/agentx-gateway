/**
 * Public origin used in catalogue URLs: `PUBLIC_BASE_URL` when set, else the forwarded host
 * (Caddy and most proxies set it), else the request's own origin.
 */
export function resolvePublicBaseUrl(
  requestUrl: string,
  headers: Headers,
  configured: string | undefined,
): string {
  if (configured) return configured.replace(/\/+$/, "");
  const host = headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  if (host) {
    const proto = headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || "http";
    return `${proto}://${host}`;
  }
  return new URL(requestUrl).origin;
}

/** Absolute URL of a stored media item's content endpoint. */
export function mediaContentUrl(baseUrl: string, id: string): string {
  return `${baseUrl}/v1/media/${encodeURIComponent(id)}/content`;
}
