export type StatusClass = "failover" | "bad_request" | "auth" | "not_found" | "other";

/** Failover on 408, 429 and 5xx; everything else is returned (mapped) to the client. */
export function classifyStatus(status: number): StatusClass {
  if (status === 408 || status === 429 || status >= 500) return "failover";
  if (status === 400 || status === 422) return "bad_request";
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "not_found";
  return "other";
}

export function isFailoverStatus(status: number): boolean {
  return classifyStatus(status) === "failover";
}

export interface MappedError {
  status: 400 | 502;
  code: string;
  message: string;
  type: string;
}

/**
 * Maps a non-failover upstream error to what the gateway returns. Never forwards 401/403/404
 * (Unity treats 404 on chat routes as an expired session).
 */
export function mapUpstreamError(
  status: number,
  providerName: string,
  upstreamMessage?: string,
): MappedError {
  switch (classifyStatus(status)) {
    case "bad_request":
      return {
        status: 400,
        code: "upstream_bad_request",
        message: upstreamMessage || "The upstream provider rejected the request.",
        type: "invalid_request_error",
      };
    case "auth":
      return {
        status: 502,
        code: "upstream_auth_failed",
        message: `Upstream provider "${providerName}" rejected the gateway's credentials (HTTP ${status}).`,
        type: "api_error",
      };
    case "not_found":
      return {
        status: 502,
        code: "upstream_not_found",
        message: `Upstream provider "${providerName}" could not find the endpoint or model (HTTP 404).`,
        type: "api_error",
      };
    default:
      return {
        status: 502,
        code: "upstream_error",
        message: `Upstream provider "${providerName}" returned HTTP ${status}.`,
        type: "api_error",
      };
  }
}

/** Pulls `error.message` out of an OpenAI-style error body, if present. */
export function extractUpstreamMessage(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } | string };
    if (typeof parsed.error === "string") return parsed.error.slice(0, 500);
    const message = parsed.error?.message;
    return typeof message === "string" ? message.slice(0, 500) : undefined;
  } catch {
    return undefined;
  }
}
