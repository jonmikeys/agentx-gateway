import { createHash, randomInt } from "node:crypto";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
export const API_KEY_PREFIX = "agx_";
const RANDOM_LENGTH = 32;
const DISPLAY_PREFIX_LENGTH = 8;

/** `agx_` + 32 random base62 characters (about 190 bits of entropy). */
export function generateApiKey(): string {
  let random = "";
  for (let index = 0; index < RANDOM_LENGTH; index += 1) random += BASE62[randomInt(62)];
  return `${API_KEY_PREFIX}${random}`;
}

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/** First characters of the key for display, e.g. `agx_ab12`. */
export function apiKeyDisplayPrefix(key: string): string {
  return key.slice(0, DISPLAY_PREFIX_LENGTH);
}
