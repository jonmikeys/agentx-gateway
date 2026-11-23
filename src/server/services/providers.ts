import { eq } from "drizzle-orm";
import type { ProviderCreateInput, ProviderUpdateInput } from "@/lib/gateway-schemas";
import { decryptSecret, encryptSecret, maskSecret } from "@/server/crypto/secrets";
import { getDb } from "@/server/db/client";
import { modelRoutes, type ProviderCapabilities, providers, routeSteps } from "@/server/db/schema";
import { type CircuitState, circuitBreaker } from "@/server/gateway/circuit-breaker";
import { ServiceError } from "@/server/services/errors";

type ProviderRow = typeof providers.$inferSelect;

/** Admin-facing provider. Secrets are write-only: only a masked key and header NAMES are exposed. */
export interface ProviderView {
  id: string;
  name: string;
  base_url: string;
  enabled: boolean;
  capabilities: ProviderCapabilities;
  api_key_masked: string | null;
  extra_header_names: string[];
  circuit_state: CircuitState;
  /** Slugs of routes whose steps use this provider (deleting is blocked while non-empty). */
  used_by_routes: string[];
  created_at: string;
  updated_at: string;
}

/** Provider with decrypted secrets, used only to call upstream. Never serialize this. */
export interface ProviderRuntime {
  id: string;
  name: string;
  baseUrl: string;
  enabled: boolean;
  capabilities: ProviderCapabilities;
  apiKey: string | null;
  extraHeaders: Record<string, string>;
}

export function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function parseHeaders(encrypted: string | null): Record<string, string> {
  if (!encrypted) return {};
  return JSON.parse(decryptSecret(encrypted)) as Record<string, string>;
}

export function toProviderRuntime(row: ProviderRow): ProviderRuntime {
  return {
    id: row.id,
    name: row.name,
    baseUrl: normalizeBaseUrl(row.baseUrl),
    enabled: row.enabled,
    capabilities: row.capabilities,
    apiKey: row.apiKey ? decryptSecret(row.apiKey) : null,
    extraHeaders: parseHeaders(row.extraHeaders),
  };
}

export function toProviderView(row: ProviderRow, usedByRoutes: string[] = []): ProviderView {
  return {
    id: row.id,
    name: row.name,
    base_url: row.baseUrl,
    enabled: row.enabled,
    capabilities: row.capabilities,
    api_key_masked: row.apiKey ? maskSecret(decryptSecret(row.apiKey)) : null,
    extra_header_names: Object.keys(parseHeaders(row.extraHeaders)),
    circuit_state: circuitBreaker.state(row.id),
    used_by_routes: usedByRoutes,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: string; cause?: { code?: string } })?.code;
  const causeCode = (error as { cause?: { code?: string } })?.cause?.code;
  return code === "23505" || causeCode === "23505";
}

export async function listProviders(): Promise<ProviderView[]> {
  const db = getDb();
  const rows = await db.select().from(providers).orderBy(providers.name);
  const usage = await db
    .selectDistinct({ providerId: routeSteps.providerId, slug: modelRoutes.slug })
    .from(routeSteps)
    .innerJoin(modelRoutes, eq(routeSteps.routeId, modelRoutes.id));
  const byProvider = new Map<string, string[]>();
  for (const { providerId, slug } of usage) {
    byProvider.set(providerId, [...(byProvider.get(providerId) ?? []), slug].sort());
  }
  return rows.map((row) => toProviderView(row, byProvider.get(row.id) ?? []));
}

async function findProviderRow(id: string): Promise<ProviderRow> {
  const [row] = await getDb().select().from(providers).where(eq(providers.id, id));
  if (!row) throw new ServiceError(404, "provider_not_found", "Provider not found");
  return row;
}

export async function getProvider(id: string): Promise<ProviderView> {
  const row = await findProviderRow(id);
  return toProviderView(row, await findRoutesUsingProvider(id));
}

/** Decrypted provider for connectivity tests. */
export async function getProviderRuntime(id: string): Promise<ProviderRuntime> {
  return toProviderRuntime(await findProviderRow(id));
}

export async function createProvider(input: ProviderCreateInput): Promise<ProviderView> {
  try {
    const [row] = await getDb()
      .insert(providers)
      .values({
        name: input.name,
        baseUrl: normalizeBaseUrl(input.base_url),
        apiKey: input.api_key ? encryptSecret(input.api_key) : null,
        enabled: input.enabled,
        capabilities: input.capabilities,
        extraHeaders: hasHeaders(input.extra_headers)
          ? encryptSecret(JSON.stringify(input.extra_headers))
          : null,
      })
      .returning();
    return toProviderView(row);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ServiceError(409, "provider_name_taken", `A provider named "${input.name}" exists`);
    }
    throw error;
  }
}

/** The keys of a partial object that were actually sent. */
function definedEntries<T extends object>(partial: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(partial).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

function hasHeaders(
  headers: Record<string, string> | null | undefined,
): headers is Record<string, string> {
  return !!headers && Object.keys(headers).length > 0;
}

export async function updateProvider(
  id: string,
  input: ProviderUpdateInput,
): Promise<ProviderView> {
  const existing = await findProviderRow(id);
  const changes: Partial<typeof providers.$inferInsert> = { updatedAt: new Date() };
  if (input.name !== undefined) changes.name = input.name;
  if (input.base_url !== undefined) changes.baseUrl = normalizeBaseUrl(input.base_url);
  if (input.enabled !== undefined) changes.enabled = input.enabled;
  if (input.capabilities !== undefined) {
    changes.capabilities = { ...existing.capabilities, ...definedEntries(input.capabilities) };
  }
  // Absent = keep; null = clear; string = replace.
  if (input.api_key !== undefined) {
    changes.apiKey = input.api_key ? encryptSecret(input.api_key) : null;
  }
  if (input.extra_headers !== undefined) {
    changes.extraHeaders = hasHeaders(input.extra_headers)
      ? encryptSecret(JSON.stringify(input.extra_headers))
      : null;
  }
  try {
    const [row] = await getDb()
      .update(providers)
      .set(changes)
      .where(eq(providers.id, id))
      .returning();
    return toProviderView(row);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ServiceError(409, "provider_name_taken", "Another provider uses that name");
    }
    throw error;
  }
}

/** Slugs of the routes whose steps use this provider. */
export async function findRoutesUsingProvider(id: string): Promise<string[]> {
  const rows = await getDb()
    .selectDistinct({ slug: modelRoutes.slug })
    .from(routeSteps)
    .innerJoin(modelRoutes, eq(routeSteps.routeId, modelRoutes.id))
    .where(eq(routeSteps.providerId, id));
  return rows.map((row) => row.slug).sort();
}

export async function deleteProvider(id: string): Promise<void> {
  await findProviderRow(id);
  const usedBy = await findRoutesUsingProvider(id);
  if (usedBy.length > 0) {
    throw new ServiceError(
      409,
      "provider_in_use",
      `Provider is used by route(s): ${usedBy.join(", ")}`,
      { routes: usedBy },
    );
  }
  await getDb().delete(providers).where(eq(providers.id, id));
}
