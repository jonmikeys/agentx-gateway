import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { getEnv, isValidEncryptionKey } from "@/server/env";

const FORMAT_VERSION = "v1";
const IV_BYTES = 12;
const MASK_PLACEHOLDER = "••••••••";

/** Decodes a base64 master key, throwing when it is not exactly 32 bytes. */
export function parseEncryptionKey(base64Key: string): Buffer {
  if (!isValidEncryptionKey(base64Key)) {
    throw new Error("Encryption key must be base64 and decode to exactly 32 bytes");
  }
  return Buffer.from(base64Key, "base64");
}

/** Generates a fresh base64 key suitable for GATEWAY_ENCRYPTION_KEY. */
export function generateEncryptionKey(): string {
  return randomBytes(32).toString("base64");
}

/** Encrypts with an explicit key. Output: `v1:<iv_b64>:<tag_b64>:<ciphertext_b64>`. */
export function encryptSecretWithKey(plaintext: string, base64Key: string): string {
  const key = parseEncryptionKey(base64Key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    FORMAT_VERSION,
    iv.toString("base64"),
    tag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
}

/** Decrypts a blob produced by `encryptSecretWithKey`. Throws on tampering or a wrong key. */
export function decryptSecretWithKey(blob: string, base64Key: string): string {
  const parts = blob.split(":");
  if (parts.length !== 4 || parts[0] !== FORMAT_VERSION) {
    throw new Error("Unsupported or malformed secret format");
  }
  const [, ivB64, tagB64, ciphertextB64] = parts;
  const key = parseEncryptionKey(base64Key);
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  if (iv.length !== IV_BYTES) throw new Error("Malformed secret IV");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextB64, "base64")),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}

/** Encrypts using `GATEWAY_ENCRYPTION_KEY`. */
export function encryptSecret(plaintext: string): string {
  return encryptSecretWithKey(plaintext, getEnv().GATEWAY_ENCRYPTION_KEY);
}

/** Decrypts using `GATEWAY_ENCRYPTION_KEY`. */
export function decryptSecret(blob: string): string {
  return decryptSecretWithKey(blob, getEnv().GATEWAY_ENCRYPTION_KEY);
}

/**
 * Display-safe form of a secret, e.g. `sk-…a1b2`. Shows a short leading prefix only
 * when it ends at a separator within the first 4 characters, plus the last 4 characters.
 * Short secrets are fully masked.
 */
export function maskSecret(secret: string): string {
  if (secret.length < 12) return MASK_PLACEHOLDER;
  const separatorIndex = secret.slice(0, 4).search(/[-_.:]/);
  const prefix = separatorIndex === -1 ? "" : secret.slice(0, separatorIndex + 1);
  return `${prefix}…${secret.slice(-4)}`;
}
