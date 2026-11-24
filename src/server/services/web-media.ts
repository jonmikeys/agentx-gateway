import { randomBytes } from "node:crypto";
import { and, eq, inArray, lt } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { sessions, type WebMediaKind, webMediaItems } from "@/server/db/schema";
import { mediaContentUrl } from "@/server/media/public-url";
import type { MediaCatalogueEntry } from "@/server/services/media";

export type WebMediaRow = typeof webMediaItems.$inferSelect;

/** Temporary media ids: `wm_` + 16 hex characters. */
export const WEB_MEDIA_PREFIX = "wm_";

export function newWebMediaId(): string {
  return `${WEB_MEDIA_PREFIX}${randomBytes(8).toString("hex")}`;
}

export function isWebMediaId(id: string): boolean {
  return /^wm_[0-9a-f]{16}$/.test(id);
}

export interface NewWebMedia {
  kind: WebMediaKind;
  title: string;
  sourcePageUrl?: string;
  mediaUrl: string;
  thumbnailUrl?: string;
  resolution?: string;
  durationSeconds?: number;
}

/** Stores found media for a session; returns the rows in input order. */
export async function createWebMediaItems(
  sessionId: string,
  apiKeyId: string,
  items: NewWebMedia[],
): Promise<WebMediaRow[]> {
  if (items.length === 0) return [];
  return getDb()
    .insert(webMediaItems)
    .values(
      items.map((item) => ({
        id: newWebMediaId(),
        sessionId,
        apiKeyId,
        kind: item.kind,
        title: item.title,
        sourcePageUrl: item.sourcePageUrl ?? null,
        mediaUrl: item.mediaUrl,
        thumbnailUrl: item.thumbnailUrl ?? null,
        resolution: item.resolution ?? null,
        durationSeconds: item.durationSeconds ?? null,
      })),
    )
    .returning();
}

/** Writes below this interval do not refresh the session's activity again. */
const TOUCH_INTERVAL_MS = 60_000;

/**
 * A temporary item visible to this API key: the key owns it and its session is still active.
 * Fetching or streaming one counts as session activity, so a long video does not let the session
 * idle out mid-playback. Anything else is `undefined` (the caller answers 404).
 */
export async function findOwnedWebMedia(
  id: string,
  apiKeyId: string,
): Promise<WebMediaRow | undefined> {
  if (!isWebMediaId(id)) return undefined;
  const db = getDb();
  const [found] = await db
    .select({
      item: webMediaItems,
      status: sessions.status,
      lastActivityAt: sessions.lastActivityAt,
    })
    .from(webMediaItems)
    .innerJoin(sessions, eq(webMediaItems.sessionId, sessions.id))
    .where(and(eq(webMediaItems.id, id), eq(webMediaItems.apiKeyId, apiKeyId)));
  if (found?.status !== "active") return undefined;
  const now = new Date();
  if (now.getTime() - found.lastActivityAt.getTime() > TOUCH_INTERVAL_MS) {
    await db
      .update(sessions)
      .set({ lastActivityAt: now })
      .where(
        and(
          eq(sessions.id, found.item.sessionId),
          eq(sessions.status, "active"),
          lt(sessions.lastActivityAt, new Date(now.getTime() - TOUCH_INTERVAL_MS)),
        ),
      );
  }
  return found.item;
}

/** Deletes the temporary media of sessions that ended or expired. */
export async function deleteWebMediaForSessions(sessionIds: string[]): Promise<void> {
  if (sessionIds.length === 0) return;
  await getDb().delete(webMediaItems).where(inArray(webMediaItems.sessionId, sessionIds));
}

export interface ResolvedStream {
  url: string;
  mimeType: string;
  headers: Record<string, string>;
}

export async function saveResolvedStream(id: string, stream: ResolvedStream): Promise<void> {
  await getDb()
    .update(webMediaItems)
    .set({
      resolvedUrl: stream.url,
      resolvedMimeType: stream.mimeType,
      resolvedHeaders: stream.headers,
      resolvedAt: new Date(),
      resolveError: null,
    })
    .where(eq(webMediaItems.id, id));
}

export async function saveResolveError(id: string, message: string): Promise<void> {
  await getDb()
    .update(webMediaItems)
    .set({ resolveError: message, resolvedAt: new Date() })
    .where(eq(webMediaItems.id, id));
}

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/** Best guess before the bytes are fetched: from the file extension, else JPEG. */
export function guessImageType(url: string): string {
  try {
    const extension = new URL(url).pathname.split(".").pop()?.toLowerCase() ?? "";
    return IMAGE_TYPES[extension] ?? "image/jpeg";
  } catch {
    return "image/jpeg";
  }
}

function hostOf(url: string | null): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

/** One line for the model and the client: where it was found and its size or length. */
export function describeWebMedia(row: WebMediaRow): string {
  const parts: string[] = [];
  const host = hostOf(row.sourcePageUrl) ?? hostOf(row.mediaUrl);
  parts.push(row.kind === "video" ? "Web video" : "Web image");
  if (host) parts[0] += ` from ${host}`;
  if (row.resolution) parts.push(row.resolution.replace(/\s*[x×]\s*/i, "×"));
  if (row.durationSeconds !== null) parts.push(formatDuration(row.durationSeconds));
  return `${parts.join(", ")}.`;
}

/** Same shape as `GET /v1/media` entries; `content_url` always points at the gateway proxy. */
export function toWebMediaEntry(row: WebMediaRow, baseUrl: string): MediaCatalogueEntry {
  return {
    id: row.id,
    name: row.title || (row.kind === "video" ? "Web video" : "Web image"),
    description: describeWebMedia(row),
    kind: row.kind,
    tags: ["web"],
    content_url: mediaContentUrl(baseUrl, row.id),
    mime_type:
      row.resolvedMimeType ?? (row.kind === "video" ? "video/mp4" : guessImageType(row.mediaUrl)),
  };
}
