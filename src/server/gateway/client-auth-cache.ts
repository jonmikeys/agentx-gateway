import type { ApiKeyRecord } from "@/server/services/api-keys";

const CACHE_TTL_MS = 30_000;

interface CacheEntry {
  record: ApiKeyRecord | undefined;
  expiresAt: number;
}

const byHash = new Map<string, CacheEntry>();

/** In-process cache of key lookups (at most 30 s old). Unknown keys are cached too. */
export function getCachedApiKey(hash: string, now = Date.now()): CacheEntry | undefined {
  const entry = byHash.get(hash);
  if (!entry) return undefined;
  if (entry.expiresAt <= now) {
    byHash.delete(hash);
    return undefined;
  }
  return entry;
}

export function cacheApiKey(hash: string, record: ApiKeyRecord | undefined, now = Date.now()) {
  if (byHash.size > 5000) byHash.clear();
  byHash.set(hash, { record, expiresAt: now + CACHE_TTL_MS });
}

/** Drops cached entries for a key id (called on revoke / update). */
export function invalidateApiKeyCache(id?: string): void {
  if (id === undefined) {
    byHash.clear();
    return;
  }
  for (const [hash, entry] of byHash) {
    if (entry.record?.id === id) byHash.delete(hash);
  }
}
