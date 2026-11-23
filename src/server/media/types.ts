import type { MediaKind } from "@/server/db/schema";

export const MEGABYTE = 1024 * 1024;
export const IMAGE_MAX_BYTES = 20 * MEGABYTE;
export const VIDEO_MAX_BYTES = 200 * MEGABYTE;
/** Bytes read from the start of a file to identify it. */
export const SNIFF_BYTES = 4100;

export interface AllowedMediaType {
  kind: MediaKind;
  extension: string;
  maxBytes: number;
}

/** The only content types the gateway stores or links, keyed by MIME type. */
export const allowedMediaTypes: Record<string, AllowedMediaType> = {
  "image/png": { kind: "image", extension: "png", maxBytes: IMAGE_MAX_BYTES },
  "image/jpeg": { kind: "image", extension: "jpg", maxBytes: IMAGE_MAX_BYTES },
  "image/gif": { kind: "image", extension: "gif", maxBytes: IMAGE_MAX_BYTES },
  "image/webp": { kind: "image", extension: "webp", maxBytes: IMAGE_MAX_BYTES },
  "video/mp4": { kind: "video", extension: "mp4", maxBytes: VIDEO_MAX_BYTES },
  "video/webm": { kind: "video", extension: "webm", maxBytes: VIDEO_MAX_BYTES },
};

export function findMediaType(mimeType: string): AllowedMediaType | undefined {
  return Object.hasOwn(allowedMediaTypes, mimeType) ? allowedMediaTypes[mimeType] : undefined;
}

/** Lower-cased MIME type without parameters (`image/PNG; charset=x` becomes `image/png`). */
export function baseMimeType(contentType: string | null | undefined): string {
  return (contentType ?? "").split(";")[0].trim().toLowerCase();
}

export function formatBytes(bytes: number): string {
  if (bytes >= MEGABYTE) return `${Math.round(bytes / MEGABYTE)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Returns an error message when `size` exceeds the limit for `mimeType`. */
export function sizeError(mimeType: string, size: number): string | undefined {
  const type = findMediaType(mimeType);
  if (!type) return `Unsupported media type ${mimeType || "(none)"}`;
  if (size > type.maxBytes) {
    return `File is ${formatBytes(size)}; ${type.kind}s may be at most ${formatBytes(type.maxBytes)}`;
  }
  return undefined;
}
