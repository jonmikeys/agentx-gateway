import { Readable } from "node:stream";
import { openAIError } from "@/server/api/errors";
import type { mediaItems } from "@/server/db/schema";
import { parseRange } from "@/server/media/range";
import type { MediaStorage } from "@/server/media/storage";

type MediaRow = typeof mediaItems.$inferSelect;

/** Uploaded files never change, so the id and size identify the bytes. */
export function mediaEtag(row: Pick<MediaRow, "id" | "sizeBytes">): string {
  return `"${row.id}-${(row.sizeBytes ?? 0).toString(16)}"`;
}

function notModified(request: Request, etag: string): boolean {
  const candidates = request.headers.get("if-none-match");
  if (!candidates) return false;
  return candidates.split(",").some((value) => value.trim().replace(/^W\//, "") === etag);
}

/** `If-Range` makes `Range` conditional: a stale validator means "send the whole file". */
function rangeApplies(request: Request, etag: string): boolean {
  const ifRange = request.headers.get("if-range");
  return !ifRange || ifRange.trim() === etag;
}

/**
 * Serves a media item: uploads are streamed from storage with `Range` support, `ETag` and
 * `Cache-Control`; external items answer `302` to their URL. Shared by `/v1/media/:id/content`
 * (Bearer) and the CRM's `/api/admin/media/:id/content` (admin).
 */
export async function serveMedia(
  request: Request,
  row: MediaRow,
  storage: MediaStorage,
): Promise<Response> {
  if (row.source === "external_url" && row.externalUrl) {
    return new Response(null, { status: 302, headers: { Location: row.externalUrl } });
  }
  const key = row.storageKey;
  const size = key ? await storage.size(key) : undefined;
  if (!key || size === undefined) {
    return openAIError(404, "media_not_found", "The media file is missing from storage.");
  }

  const etag = mediaEtag({ id: row.id, sizeBytes: size });
  const headers = new Headers({
    "Content-Type": row.mimeType,
    "Accept-Ranges": "bytes",
    ETag: etag,
    "Cache-Control": "private, max-age=3600",
    "X-Content-Type-Options": "nosniff",
    "Content-Disposition": "inline",
  });
  if (notModified(request, etag)) return new Response(null, { status: 304, headers });

  const range = rangeApplies(request, etag)
    ? parseRange(request.headers.get("range"), size)
    : ({ kind: "full" } as const);
  if (range.kind === "unsatisfiable") {
    headers.set("Content-Range", `bytes */${size}`);
    headers.set("Content-Length", "0");
    return new Response(null, { status: 416, headers });
  }

  const partial = range.kind === "partial";
  const start = partial ? range.start : 0;
  const end = partial ? range.end : size - 1;
  headers.set("Content-Length", String(end - start + 1));
  if (partial) headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
  if (request.method === "HEAD")
    return new Response(null, { status: partial ? 206 : 200, headers });

  const body = Readable.toWeb(storage.open(key, { start, end })) as ReadableStream;
  return new Response(body, { status: partial ? 206 : 200, headers });
}
