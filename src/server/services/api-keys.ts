import { and, desc, eq, isNull } from "drizzle-orm";
import type { ApiKeyCreateInput, ApiKeyUpdateInput } from "@/lib/gateway-schemas";
import { getDb } from "@/server/db/client";
import { apiKeys } from "@/server/db/schema";
import { apiKeyDisplayPrefix, generateApiKey, hashApiKey } from "@/server/gateway/api-key-format";
import { invalidateApiKeyCache } from "@/server/gateway/client-auth-cache";
import { ServiceError } from "@/server/services/errors";

type ApiKeyRow = typeof apiKeys.$inferSelect;

export interface ApiKeyView {
  id: string;
  label: string;
  key_prefix: string;
  ip_allowlist: string[];
  rpm_limit: number | null;
  tokens_per_day_limit: number | null;
  revoked_at: string | null;
  last_used_at: string | null;
  created_at: string;
}

/** The authenticated key as seen by client-auth (no secret material). */
export interface ApiKeyRecord {
  id: string;
  label: string;
  ipAllowlist: string[];
  rpmLimit: number | null;
  tokensPerDayLimit: number | null;
  revokedAt: Date | null;
}

export function toApiKeyView(row: ApiKeyRow): ApiKeyView {
  return {
    id: row.id,
    label: row.label,
    key_prefix: row.keyPrefix,
    ip_allowlist: row.ipAllowlist,
    rpm_limit: row.rpmLimit,
    tokens_per_day_limit: row.tokensPerDayLimit,
    revoked_at: row.revokedAt?.toISOString() ?? null,
    last_used_at: row.lastUsedAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
  };
}

export async function listApiKeys(): Promise<ApiKeyView[]> {
  const rows = await getDb().select().from(apiKeys).orderBy(desc(apiKeys.createdAt));
  return rows.map(toApiKeyView);
}

/** Creates a key. The plaintext is returned exactly once and never stored. */
export async function createApiKey(
  input: ApiKeyCreateInput,
): Promise<{ key: string; apiKey: ApiKeyView }> {
  const key = generateApiKey();
  const [row] = await getDb()
    .insert(apiKeys)
    .values({
      label: input.label,
      keyPrefix: apiKeyDisplayPrefix(key),
      keyHash: hashApiKey(key),
      ipAllowlist: input.ip_allowlist,
      rpmLimit: input.rpm_limit,
      tokensPerDayLimit: input.tokens_per_day_limit,
    })
    .returning();
  return { key, apiKey: toApiKeyView(row) };
}

export async function updateApiKey(id: string, input: ApiKeyUpdateInput): Promise<ApiKeyView> {
  const changes: Partial<typeof apiKeys.$inferInsert> = {};
  if (input.label !== undefined) changes.label = input.label;
  if (input.ip_allowlist !== undefined) changes.ipAllowlist = input.ip_allowlist;
  if (input.rpm_limit !== undefined) changes.rpmLimit = input.rpm_limit;
  if (input.tokens_per_day_limit !== undefined)
    changes.tokensPerDayLimit = input.tokens_per_day_limit;
  const query = getDb().update(apiKeys);
  const [row] =
    Object.keys(changes).length === 0
      ? await getDb().select().from(apiKeys).where(eq(apiKeys.id, id))
      : await query.set(changes).where(eq(apiKeys.id, id)).returning();
  if (!row) throw new ServiceError(404, "api_key_not_found", "API key not found");
  invalidateApiKeyCache(id);
  return toApiKeyView(row);
}

export async function revokeApiKey(id: string): Promise<ApiKeyView> {
  const [row] = await getDb()
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiKeys.id, id), isNull(apiKeys.revokedAt)))
    .returning();
  if (!row) {
    const [existing] = await getDb().select().from(apiKeys).where(eq(apiKeys.id, id));
    if (!existing) throw new ServiceError(404, "api_key_not_found", "API key not found");
    return toApiKeyView(existing);
  }
  invalidateApiKeyCache(id);
  return toApiKeyView(row);
}

/** Looks up a key by its SHA-256 hash (revoked keys are returned with `revokedAt` set). */
export async function findApiKeyByHash(hash: string): Promise<ApiKeyRecord | undefined> {
  const [row] = await getDb().select().from(apiKeys).where(eq(apiKeys.keyHash, hash));
  if (!row) return undefined;
  return {
    id: row.id,
    label: row.label,
    ipAllowlist: row.ipAllowlist,
    rpmLimit: row.rpmLimit,
    tokensPerDayLimit: row.tokensPerDayLimit,
    revokedAt: row.revokedAt,
  };
}

export async function touchApiKey(id: string): Promise<void> {
  await getDb().update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, id));
}
