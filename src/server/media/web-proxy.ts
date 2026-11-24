import { openAIError } from "@/server/api/errors";
import { logger } from "@/server/logger";
import { PublicFetchError, publicFetch } from "@/server/net/public-fetch";
import {
  type ResolvedStream,
  saveResolvedStream,
  saveResolveError,
  type WebMediaRow,
} from "@/server/services/web-media";
import { WEB_USER_AGENT } from "@/server/tools/builtin/read-web-page";

/** Image types clients can show (the Unity probe accepts exactly these). */
export const PROXY_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export const PROXY_IMAGE_MAX_BYTES = 20 * 1024 * 1024;

/** Upstream response headers passed through to the client. */
const PASS_HEADERS = ["content-length", "content-range", "accept-ranges", "last-modified", "etag"];

/** Resolves a video page to a direct stream (yt-dlp); throws an Error with a readable message. */
export type VideoResolver = (row: WebMediaRow, signal?: AbortSignal) => Promise<ResolvedStream>;

interface Candidate {
  url: string;
  headers: Record<string, string>;
}

function mediaUnavailable(message: string): Response {
  return openAIError(502, "media_unavailable", message, "api_error");
}

function baseType(response: Response): string {
  return (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
}

/** Opens one upstream candidate with the client's Range / If-Range headers. */
async function openUpstream(
  candidate: Candidate,
  request: Request,
): Promise<{ response: Response } | { error: string }> {
  const headers: Record<string, string> = { ...candidate.headers };
  const range = request.headers.get("range");
  const ifRange = request.headers.get("if-range");
  if (range) headers.Range = range;
  if (range && ifRange) headers["If-Range"] = ifRange;
  try {
    const { response } = await publicFetch(candidate.url, {
      headers,
      signal: request.signal,
      stream: true,
    });
    return { response };
  } catch (error) {
    if (error instanceof PublicFetchError) return { error: error.message };
    throw error;
  }
}

/** Builds the client response: streamed body (or none for HEAD) with pass-through headers. */
function relay(request: Request, upstream: Response, contentType: string): Response {
  const headers = new Headers({
    "Content-Type": contentType,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Disposition": "inline",
  });
  for (const name of PASS_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (!headers.has("accept-ranges") && upstream.status === 206) {
    headers.set("Accept-Ranges", "bytes");
  }
  if (request.method === "HEAD") {
    void upstream.body?.cancel();
    return new Response(null, { status: upstream.status, headers });
  }
  return new Response(upstream.body, { status: upstream.status, headers });
}

function acceptableImage(response: Response): boolean {
  if (response.status !== 200 && response.status !== 206) return false;
  if (!PROXY_IMAGE_TYPES.has(baseType(response))) return false;
  const length = Number(response.headers.get("content-length") ?? "0");
  return response.status === 206 || !(length > PROXY_IMAGE_MAX_BYTES);
}

/**
 * Images: the full-size file first, the search engine's thumbnail as a fallback when the source
 * refuses, is not a supported type or is larger than 20 MB. The candidate that worked is cached
 * on the row so later (ranged) requests get the same bytes.
 */
async function serveImage(request: Request, row: WebMediaRow): Promise<Response> {
  const browserHeaders = { "User-Agent": WEB_USER_AGENT, Accept: "image/*,*/*;q=0.5" };
  const candidates: Candidate[] = row.resolvedUrl
    ? [{ url: row.resolvedUrl, headers: { ...browserHeaders, ...(row.resolvedHeaders ?? {}) } }]
    : [
        {
          url: row.mediaUrl,
          headers: row.sourcePageUrl
            ? { ...browserHeaders, Referer: row.sourcePageUrl }
            : browserHeaders,
        },
        ...(row.thumbnailUrl ? [{ url: row.thumbnailUrl, headers: browserHeaders }] : []),
      ];
  let lastError = "The image could not be loaded from its source.";
  for (const candidate of candidates) {
    const opened = await openUpstream(candidate, request);
    if ("error" in opened) {
      lastError = opened.error;
      continue;
    }
    const { response } = opened;
    if (response.status === 416) {
      return relay(request, response, row.resolvedMimeType ?? "image/jpeg");
    }
    if (!acceptableImage(response)) {
      await response.body?.cancel();
      lastError =
        response.status === 200 || response.status === 206
          ? "The image is not a PNG, JPEG, GIF or WebP file under 20 MB."
          : `The image source answered HTTP ${response.status}.`;
      continue;
    }
    const type = baseType(response);
    if (!row.resolvedUrl) {
      const extra: Record<string, string> = candidate.headers.Referer
        ? { Referer: candidate.headers.Referer }
        : {};
      await saveResolvedStream(row.id, { url: candidate.url, mimeType: type, headers: extra });
    }
    return relay(request, response, type);
  }
  return mediaUnavailable(lastError);
}

/** Resolutions in flight per item, so parallel first requests run the resolver once. */
const pending = new Map<string, Promise<ResolvedStream>>();

async function resolveOnce(row: WebMediaRow, resolver: VideoResolver): Promise<ResolvedStream> {
  const existing = pending.get(row.id);
  if (existing) return existing;
  const started = performance.now();
  const promise = resolver(row)
    .then(async (stream) => {
      await saveResolvedStream(row.id, stream);
      logger.info("web video resolved", {
        media_id: row.id,
        duration_ms: Math.round(performance.now() - started),
      });
      return stream;
    })
    .catch(async (error: unknown) => {
      const message = error instanceof Error ? error.message : "The video could not be resolved.";
      await saveResolveError(row.id, message);
      logger.warn("web video resolution failed", {
        media_id: row.id,
        duration_ms: Math.round(performance.now() - started),
      });
      throw new Error(message);
    })
    .finally(() => pending.delete(row.id));
  pending.set(row.id, promise);
  return promise;
}

/**
 * Videos: resolved lazily on the first request (cached on the row for the session), then
 * streamed through with Range forwarded. An expired link simply fails (accepted by design).
 */
async function serveVideo(
  request: Request,
  row: WebMediaRow,
  resolver: VideoResolver | undefined,
): Promise<Response> {
  if (row.resolveError) return mediaUnavailable(row.resolveError);
  let stream: ResolvedStream;
  if (row.resolvedUrl) {
    stream = {
      url: row.resolvedUrl,
      mimeType: row.resolvedMimeType ?? "video/mp4",
      headers: row.resolvedHeaders ?? {},
    };
  } else {
    if (!resolver) return mediaUnavailable("Video playback is not available on this gateway.");
    try {
      stream = await resolveOnce(row, resolver);
    } catch (error) {
      return mediaUnavailable(error instanceof Error ? error.message : "The video is unavailable.");
    }
  }
  const opened = await openUpstream({ url: stream.url, headers: stream.headers }, request);
  if ("error" in opened) return mediaUnavailable(opened.error);
  const { response } = opened;
  if (response.status === 416) return relay(request, response, stream.mimeType);
  if (response.status !== 200 && response.status !== 206) {
    await response.body?.cancel();
    return mediaUnavailable(
      `The video source answered HTTP ${response.status}; the link may have expired.`,
    );
  }
  return relay(request, response, stream.mimeType);
}

/** Serves `GET|HEAD /v1/media/{wm_…}/content`: streams the bytes through, storing nothing. */
export async function serveWebMedia(
  request: Request,
  row: WebMediaRow,
  options: { resolveVideo?: VideoResolver } = {},
): Promise<Response> {
  return row.kind === "image"
    ? serveImage(request, row)
    : serveVideo(request, row, options.resolveVideo);
}
