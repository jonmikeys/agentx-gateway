import { randomBytes } from "node:crypto";
import { and, arrayContains, desc, eq, ilike, or, sql } from "drizzle-orm";
import { imageSize } from "image-size";
import type { MediaExternalCreateInput, MediaQuery, MediaUpdateInput } from "@/lib/media-schemas";
import { normalizeTags, tagsSchema } from "@/lib/media-schemas";
import { getDb } from "@/server/db/client";
import { type MediaKind, type MediaSource, mediaItems } from "@/server/db/schema";
import { logger } from "@/server/logger";
import { inspectExternalMedia } from "@/server/media/external";
import { mediaContentUrl } from "@/server/media/public-url";
import { getMediaStorage, type MediaStorage } from "@/server/media/storage";
import { receiveUpload } from "@/server/media/upload";
import { ServiceError } from "@/server/services/errors";

type MediaRow = typeof mediaItems.$inferSelect;

export function newMediaId(): string {
  return `med_${randomBytes(6).toString("hex")}`;
}

/** Admin-facing media item. `preview_url` is what the CRM renders (admin-authenticated). */
export interface MediaView {
  id: string;
  name: string;
  description: string;
  kind: MediaKind;
  tags: string[];
  enabled: boolean;
  source: MediaSource;
  external_url: string | null;
  mime_type: string;
  size_bytes: number | null;
  width: number | null;
  height: number | null;
  preview_url: string;
  created_at: string;
  updated_at: string;
}

/** Catalogue entry returned to Unity by `GET /v1/media`. */
export interface MediaCatalogueEntry {
  id: string;
  name: string;
  description: string;
  kind: MediaKind;
  tags: string[];
  content_url: string;
  mime_type: string;
}

export function toMediaView(row: MediaRow): MediaView {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    kind: row.kind,
    tags: row.tags,
    enabled: row.enabled,
    source: row.source,
    external_url: row.externalUrl,
    mime_type: row.mimeType,
    size_bytes: row.sizeBytes,
    width: row.width,
    height: row.height,
    preview_url: `/api/admin/media/${row.id}/content`,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

export function toCatalogueEntry(row: MediaRow, baseUrl: string): MediaCatalogueEntry {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    kind: row.kind,
    tags: row.tags,
    content_url:
      row.source === "external_url" && row.externalUrl
        ? row.externalUrl
        : mediaContentUrl(baseUrl, row.id),
    mime_type: row.mimeType,
  };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

export async function listMedia(query: MediaQuery = {}): Promise<MediaRow[]> {
  const conditions = [];
  if (query.kind) conditions.push(eq(mediaItems.kind, query.kind));
  if (query.tag) conditions.push(arrayContains(mediaItems.tags, [query.tag.toLowerCase()]));
  if (query.enabled !== undefined) conditions.push(eq(mediaItems.enabled, query.enabled));
  if (query.q) {
    const pattern = `%${escapeLike(query.q)}%`;
    conditions.push(or(ilike(mediaItems.name, pattern), ilike(mediaItems.description, pattern)));
  }
  return getDb()
    .select()
    .from(mediaItems)
    .where(and(...conditions))
    .orderBy(desc(mediaItems.createdAt), mediaItems.id);
}

/** Enabled items for the client catalogue, ordered by name. */
export async function listEnabledMedia(): Promise<MediaRow[]> {
  return getDb()
    .select()
    .from(mediaItems)
    .where(eq(mediaItems.enabled, true))
    .orderBy(mediaItems.name, mediaItems.id);
}

export async function listMediaTags(): Promise<string[]> {
  const result = await getDb().execute<{ tag: string }>(
    sql`select distinct unnest(tags) as tag from media_items order by tag`,
  );
  return result.map((row) => row.tag);
}

export async function findMedia(id: string): Promise<MediaRow | undefined> {
  const [row] = await getDb().select().from(mediaItems).where(eq(mediaItems.id, id));
  return row;
}

async function requireMedia(id: string): Promise<MediaRow> {
  const row = await findMedia(id);
  if (!row) throw new ServiceError(404, "media_not_found", "Media item not found");
  return row;
}

/** Reads width and height from a stored image; null when the header cannot be parsed. */
async function readImageDimensions(
  storage: MediaStorage,
  key: string,
): Promise<{ width: number; height: number } | null> {
  const read = async (limit: number) => {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of storage.open(key, { start: 0, end: limit - 1 })) {
      chunks.push(chunk as Buffer);
      total += (chunk as Buffer).length;
    }
    return { buffer: Buffer.concat(chunks, total), total };
  };
  // Most headers fit in 128 KB; JPEGs with large EXIF blocks may need the whole (<= 20 MB) file.
  for (const limit of [128 * 1024, 20 * 1024 * 1024]) {
    const { buffer, total } = await read(limit);
    try {
      const size = imageSize(buffer);
      if (size.width && size.height) return { width: size.width, height: size.height };
    } catch {
      // Try the larger window below.
    }
    if (total < limit) break;
  }
  return null;
}

/** Stores an uploaded file (multipart request) and creates its media item. */
export async function createUploadedMedia(
  request: Request,
  storage: MediaStorage = getMediaStorage(),
): Promise<MediaRow> {
  const id = newMediaId();
  const upload = await receiveUpload(request, storage, (extension) => `${id}.${extension}`);
  try {
    const name = (upload.fields.name ?? "").trim() || upload.filename.replace(/\.[^.]+$/, "");
    const description = (upload.fields.description ?? "").trim().slice(0, 1000);
    const tags = tagsSchema.safeParse(parseTagField(upload.fields.tags));
    if (!tags.success) {
      throw new ServiceError(400, "validation_error", `tags: ${tags.error.issues[0]?.message}`);
    }
    if (!name || name.length > 120) {
      throw new ServiceError(
        400,
        "validation_error",
        "name: Enter a name of at most 120 characters",
      );
    }
    const dimensions =
      upload.type.kind === "image" ? await readImageDimensions(storage, upload.storageKey) : null;
    const [row] = await getDb()
      .insert(mediaItems)
      .values({
        id,
        name,
        description,
        kind: upload.type.kind,
        tags: tags.data,
        enabled: upload.fields.enabled !== "false",
        source: "upload",
        storageKey: upload.storageKey,
        mimeType: upload.mimeType,
        sizeBytes: upload.sizeBytes,
        width: dimensions?.width ?? null,
        height: dimensions?.height ?? null,
      })
      .returning();
    return row;
  } catch (error) {
    await storage.remove(upload.storageKey).catch(() => undefined);
    throw error;
  }
}

/** Accepts `a, b` or a JSON array in the multipart `tags` field. */
function parseTagField(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  if (value.trim().startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed)) return normalizeTags(parsed.map(String));
    } catch {
      // Fall through to comma-separated parsing.
    }
  }
  return normalizeTags(value.split(","));
}

export async function createExternalMedia(input: MediaExternalCreateInput): Promise<MediaRow> {
  const info = await inspectExternalMedia(input.external_url);
  const [row] = await getDb()
    .insert(mediaItems)
    .values({
      id: newMediaId(),
      name: input.name,
      description: input.description,
      kind: info.kind,
      tags: input.tags,
      enabled: input.enabled,
      source: "external_url",
      externalUrl: input.external_url,
      mimeType: info.mimeType,
      sizeBytes: info.sizeBytes,
    })
    .returning();
  return row;
}

export async function updateMedia(id: string, input: MediaUpdateInput): Promise<MediaRow> {
  await requireMedia(id);
  const changes: Partial<typeof mediaItems.$inferInsert> = { updatedAt: new Date() };
  if (input.name !== undefined) changes.name = input.name;
  if (input.description !== undefined) changes.description = input.description;
  if (input.tags !== undefined) changes.tags = input.tags;
  if (input.enabled !== undefined) changes.enabled = input.enabled;
  const [row] = await getDb()
    .update(mediaItems)
    .set(changes)
    .where(eq(mediaItems.id, id))
    .returning();
  return row;
}

/** Deletes the item and, for uploads, its stored file. */
export async function deleteMedia(
  id: string,
  storage: MediaStorage = getMediaStorage(),
): Promise<void> {
  const row = await requireMedia(id);
  await getDb().delete(mediaItems).where(eq(mediaItems.id, id));
  if (row.storageKey) {
    await storage.remove(row.storageKey).catch((error: unknown) =>
      logger.warn("Could not remove media file", {
        media_id: id,
        error: error instanceof Error ? error.message : "unknown error",
      }),
    );
  }
}
