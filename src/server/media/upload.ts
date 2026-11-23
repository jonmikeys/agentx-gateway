import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import busboy from "busboy";
import { sniffAllowedMimeType } from "@/server/media/sniff";
import type { MediaStorage } from "@/server/media/storage";
import {
  type AllowedMediaType,
  findMediaType,
  formatBytes,
  SNIFF_BYTES,
  VIDEO_MAX_BYTES,
} from "@/server/media/types";
import { ServiceError } from "@/server/services/errors";

/** Largest multipart body accepted (the biggest file plus form overhead). */
export const MAX_UPLOAD_REQUEST_BYTES = VIDEO_MAX_BYTES + 1024 * 1024;

export interface StoredUpload {
  /** Text fields sent before the file part. */
  fields: Record<string, string>;
  filename: string;
  mimeType: string;
  type: AllowedMediaType;
  sizeBytes: number;
  storageKey: string;
}

function invalidUpload(message: string): ServiceError {
  return new ServiceError(400, "invalid_upload", message);
}

/**
 * Streams the single `file` part of a multipart request into `storage`. Text fields must precede
 * the file part. The type comes from the file's magic bytes, the size limit from that type, and
 * a rejected upload leaves nothing in storage. `keyFor` maps the detected extension to a key.
 */
export async function receiveUpload(
  request: Request,
  storage: MediaStorage,
  keyFor: (extension: string) => string,
): Promise<StoredUpload> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data") || !request.body) {
    throw invalidUpload("Send the file as multipart/form-data with a 'file' part");
  }
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_UPLOAD_REQUEST_BYTES) {
    throw new ServiceError(
      413,
      "media_too_large",
      `Upload is larger than the ${formatBytes(VIDEO_MAX_BYTES)} limit`,
    );
  }

  const fields: Record<string, string> = {};
  let stored: Promise<Omit<StoredUpload, "fields">> | undefined;
  let parseError: Error | undefined;

  const parser = busboy({
    headers: { "content-type": contentType },
    limits: { files: 1, fileSize: VIDEO_MAX_BYTES + 1, fields: 20, fieldSize: 16 * 1024 },
  });
  parser.on("field", (name, value) => {
    fields[name] = value;
  });
  parser.on("file", (name, stream, info) => {
    if (name !== "file" || stored) {
      stream.resume();
      return;
    }
    stored = storeFile(stream, info.filename ?? "upload", storage, keyFor);
    // Surface the failure through `stored` below, not as an unhandled rejection.
    stored.catch(() => undefined);
  });

  const done = new Promise<void>((resolve, reject) => {
    parser.on("close", resolve);
    parser.on("error", (error) => {
      parseError = error instanceof Error ? error : new Error("Malformed multipart body");
      reject(parseError);
    });
  });

  Readable.fromWeb(request.body as NodeReadableStream).pipe(parser);
  try {
    await done;
  } catch {
    // A malformed body: remove whatever was already stored before reporting it.
    await stored?.then((upload) => storage.remove(upload.storageKey)).catch(() => undefined);
    throw invalidUpload("The upload is not valid multipart/form-data");
  }
  if (!stored) throw invalidUpload("No 'file' part in the upload");
  return { fields, ...(await stored) };
}

async function storeFile(
  stream: Readable & { truncated?: boolean },
  filename: string,
  storage: MediaStorage,
  keyFor: (extension: string) => string,
): Promise<Omit<StoredUpload, "fields">> {
  // Keep the stream alive when the iterator is released: the parser needs it drained, not destroyed.
  const iterator = stream.iterator({ destroyOnReturn: false }) as AsyncIterator<Buffer>;
  const chunks: Buffer[] = [];
  let headLength = 0;
  let ended = false;
  try {
    while (headLength < SNIFF_BYTES) {
      const next = await iterator.next();
      if (next.done) {
        ended = true;
        break;
      }
      chunks.push(next.value);
      headLength += next.value.length;
    }
    const head = Buffer.concat(chunks);
    if (head.length === 0) throw invalidUpload("The file is empty");

    const mimeType = await sniffAllowedMimeType(head);
    const detected = mimeType ? findMediaType(mimeType) : undefined;
    if (!mimeType || !detected) {
      throw new ServiceError(
        415,
        "unsupported_media_type",
        "Unsupported file. Allowed: PNG, JPEG, GIF, WebP images and MP4, WebM videos (checked by content, not by name)",
      );
    }

    const type: AllowedMediaType = detected;
    let received = head.length;
    async function* body(): AsyncGenerator<Buffer> {
      yield head;
      while (!ended) {
        const next = await iterator.next();
        if (next.done) return;
        received += next.value.length;
        if (received > type.maxBytes || stream.truncated) {
          throw new ServiceError(
            413,
            "media_too_large",
            `${type.kind === "image" ? "Images" : "Videos"} may be at most ${formatBytes(type.maxBytes)}`,
          );
        }
        yield next.value;
      }
    }
    if (head.length > type.maxBytes) {
      throw new ServiceError(
        413,
        "media_too_large",
        `Files may be at most ${formatBytes(type.maxBytes)}`,
      );
    }

    const storageKey = keyFor(type.extension);
    const sizeBytes = await storage.save(storageKey, Readable.from(body()));
    return { filename, mimeType, type, sizeBytes, storageKey };
  } finally {
    // Always drain what is left so the multipart parser can finish and the request completes.
    await iterator.return?.();
    stream.resume();
  }
}
