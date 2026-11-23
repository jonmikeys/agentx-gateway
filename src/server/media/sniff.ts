import { fileTypeFromBuffer } from "file-type";
import { findMediaType } from "@/server/media/types";

/**
 * Identifies a file from its magic bytes. The client-declared type and the file extension are
 * never trusted. Returns the MIME type only when it is one of the allowed types.
 */
export async function sniffAllowedMimeType(head: Uint8Array): Promise<string | undefined> {
  const detected = await fileTypeFromBuffer(head);
  if (!detected) return undefined;
  return findMediaType(detected.mime) ? detected.mime : undefined;
}
