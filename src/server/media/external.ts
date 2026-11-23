import type { MediaKind } from "@/server/db/schema";
import { baseMimeType, findMediaType, formatBytes, sizeError } from "@/server/media/types";
import { ServiceError } from "@/server/services/errors";

export const EXTERNAL_TIMEOUT_MS = 10_000;
export const EXTERNAL_MAX_REDIRECTS = 3;

export interface ExternalMediaInfo {
  mimeType: string;
  kind: MediaKind;
  /** Null when the server reported no size. */
  sizeBytes: number | null;
}

export interface InspectOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxRedirects?: number;
}

function unreachable(reason: string): ServiceError {
  return new ServiceError(400, "external_url_unreachable", `Could not check the URL: ${reason}`);
}

/** Issues one request, following at most `maxRedirects` redirects by hand (each hop must be http(s)). */
async function requestWithRedirects(
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
  maxRedirects: number,
): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const response = await fetchImpl(current, { ...init, redirect: "manual" });
    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || !location) return response;
    await response.body?.cancel().catch(() => undefined);
    const next = new URL(location, current);
    if (next.protocol !== "http:" && next.protocol !== "https:") {
      throw unreachable("it redirects to a non-http(s) address");
    }
    current = next.toString();
  }
  throw unreachable(`it redirects more than ${maxRedirects} times`);
}

function sizeFromHeaders(response: Response): number | null {
  const range = /\/(\d+)$/.exec(response.headers.get("content-range") ?? "");
  if (response.status === 206 && range) return Number(range[1]);
  const length = response.headers.get("content-length");
  return length !== null && /^\d+$/.test(length) ? Number(length) : null;
}

/**
 * Checks an external media URL before it is saved: `HEAD` first (falling back to a one-byte
 * ranged `GET`), 10 s timeout, at most 3 redirects, an allowed content type and a size within
 * the limit for that type. Throws `ServiceError` with a message suitable for the CRM.
 */
export async function inspectExternalMedia(
  url: string,
  options: InspectOptions = {},
): Promise<ExternalMediaInfo> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxRedirects = options.maxRedirects ?? EXTERNAL_MAX_REDIRECTS;
  const signal = AbortSignal.timeout(options.timeoutMs ?? EXTERNAL_TIMEOUT_MS);

  const probe = async (init: RequestInit) => {
    const response = await requestWithRedirects(url, { ...init, signal }, fetchImpl, maxRedirects);
    await response.body?.cancel().catch(() => undefined);
    return response;
  };
  const rangedGet = () => probe({ method: "GET", headers: { Range: "bytes=0-0" } });

  let response: Response | undefined;
  try {
    const head = await probe({ method: "HEAD" });
    if (head.ok) response = head;
  } catch (error) {
    if (error instanceof ServiceError) throw error;
  }
  try {
    response ??= await rangedGet();
    if (response.ok && response.status !== 206 && sizeFromHeaders(response) === null) {
      // Some servers omit Content-Length on HEAD; a ranged GET reveals the total.
      const ranged = await rangedGet().catch(() => undefined);
      if (ranged?.ok) response = ranged;
    }
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    throw unreachable(
      timedOut ? "the server did not answer within 10 seconds" : "it is unreachable",
    );
  }

  if (!response.ok) throw unreachable(`the server answered HTTP ${response.status}`);

  const mimeType = baseMimeType(response.headers.get("content-type"));
  const type = findMediaType(mimeType);
  if (!type) {
    throw new ServiceError(
      415,
      "unsupported_media_type",
      `The URL serves ${mimeType || "an unknown content type"}; allowed: PNG, JPEG, GIF, WebP images and MP4, WebM videos`,
    );
  }
  const sizeBytes = sizeFromHeaders(response);
  if (sizeBytes !== null) {
    const tooLarge = sizeError(mimeType, sizeBytes);
    if (tooLarge) {
      throw new ServiceError(
        413,
        "media_too_large",
        `The URL serves ${formatBytes(sizeBytes)}; ${type.kind}s may be at most ${formatBytes(type.maxBytes)}`,
      );
    }
  }
  return { mimeType, kind: type.kind, sizeBytes };
}
