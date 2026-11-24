import { asc, eq, inArray } from "drizzle-orm";
import type { BuiltinToolName } from "@/lib/builtin-tools";
import type { RouteWriteInput } from "@/lib/gateway-schemas";
import { getDb } from "@/server/db/client";
import { modelRoutes, providers, routeMcpTools, routeSteps } from "@/server/db/schema";
import { ServiceError } from "@/server/services/errors";
import {
  assertMcpToolsAllowed,
  type ResolvedMcpTool,
  resolveRouteMcpTools,
  routeMcpToolIds,
} from "@/server/services/mcp";
import { type ProviderRuntime, toProviderRuntime } from "@/server/services/providers";
import { availableBuiltinTools } from "@/server/tools/builtin/registry";

export interface RouteStepView {
  position: number;
  provider_id: string;
  provider_name: string;
  upstream_model: string;
  timeout_ms: number;
}

export interface RouteView {
  id: string;
  slug: string;
  description: string;
  enabled: boolean;
  is_default: boolean;
  steps: RouteStepView[];
  /** Selected MCP tools (ids from `mcp_tools`). */
  mcp_tool_ids: string[];
  /** Selected built-in tools, whether or not this deployment can currently run them. */
  builtin_tools: BuiltinToolName[];
  created_at: string;
  updated_at: string;
}

export interface ResolvedStep {
  provider: ProviderRuntime;
  upstreamModel: string;
  timeoutMs: number;
}

export interface ResolvedRoute {
  slug: string;
  id: string;
  steps: ResolvedStep[];
  /** Allowed MCP tools offered on this route; empty when the route has none. */
  mcpTools: ResolvedMcpTool[];
  /** Selected built-in tools this deployment can run (for example, search needs SEARXNG_URL). */
  builtinTools: BuiltinToolName[];
}

type RouteRow = typeof modelRoutes.$inferSelect;

async function loadStepViews(routeIds: string[]): Promise<Map<string, RouteStepView[]>> {
  const map = new Map<string, RouteStepView[]>();
  if (routeIds.length === 0) return map;
  const rows = await getDb()
    .select({
      routeId: routeSteps.routeId,
      position: routeSteps.position,
      providerId: routeSteps.providerId,
      providerName: providers.name,
      upstreamModel: routeSteps.upstreamModel,
      timeoutMs: routeSteps.timeoutMs,
    })
    .from(routeSteps)
    .innerJoin(providers, eq(routeSteps.providerId, providers.id))
    .where(inArray(routeSteps.routeId, routeIds))
    .orderBy(asc(routeSteps.position));
  for (const row of rows) {
    const list = map.get(row.routeId) ?? [];
    list.push({
      position: row.position,
      provider_id: row.providerId,
      provider_name: row.providerName,
      upstream_model: row.upstreamModel,
      timeout_ms: row.timeoutMs,
    });
    map.set(row.routeId, list);
  }
  return map;
}

/** Stored names that still exist in the catalogue, in catalogue order. */
function knownBuiltinTools(stored: readonly string[]): BuiltinToolName[] {
  return availableBuiltinTools(stored, { url: "", safesearch: 1 });
}

function toView(row: RouteRow, steps: RouteStepView[], mcpToolIds: string[]): RouteView {
  return {
    id: row.id,
    slug: row.slug,
    description: row.description,
    enabled: row.enabled,
    is_default: row.isDefault,
    steps,
    mcp_tool_ids: mcpToolIds,
    builtin_tools: knownBuiltinTools(row.builtinTools),
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

export async function listRoutes(): Promise<RouteView[]> {
  const rows = await getDb().select().from(modelRoutes).orderBy(asc(modelRoutes.slug));
  const ids = rows.map((row) => row.id);
  const [steps, mcpIds] = await Promise.all([loadStepViews(ids), routeMcpToolIds(ids)]);
  return rows.map((row) => toView(row, steps.get(row.id) ?? [], mcpIds.get(row.id) ?? []));
}

export async function getRoute(id: string): Promise<RouteView> {
  const [row] = await getDb().select().from(modelRoutes).where(eq(modelRoutes.id, id));
  if (!row) throw new ServiceError(404, "route_not_found", "Route not found");
  const [steps, mcpIds] = await Promise.all([loadStepViews([row.id]), routeMcpToolIds([row.id])]);
  return toView(row, steps.get(row.id) ?? [], mcpIds.get(row.id) ?? []);
}

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: string })?.code;
  const causeCode = (error as { cause?: { code?: string } })?.cause?.code;
  return code === "23505" || causeCode === "23505";
}

async function assertProvidersExist(providerIds: string[]): Promise<void> {
  const unique = [...new Set(providerIds)];
  const found = await getDb()
    .select({ id: providers.id })
    .from(providers)
    .where(inArray(providers.id, unique));
  if (found.length !== unique.length) {
    throw new ServiceError(400, "provider_not_found", "A step references an unknown provider");
  }
}

export async function createRoute(input: RouteWriteInput): Promise<RouteView> {
  await assertProvidersExist(input.steps.map((step) => step.provider_id));
  await assertMcpToolsAllowed(input.mcp_tool_ids);
  try {
    const id = await getDb().transaction(async (tx) => {
      const existing = await tx.select({ id: modelRoutes.id }).from(modelRoutes).limit(1);
      const [row] = await tx
        .insert(modelRoutes)
        .values({
          slug: input.slug,
          description: input.description,
          enabled: input.enabled,
          builtinTools: [...new Set(input.builtin_tools)],
          // The first route ever created becomes the default.
          isDefault: existing.length === 0,
        })
        .returning();
      await tx.insert(routeSteps).values(stepValues(row.id, input));
      const toolIds = [...new Set(input.mcp_tool_ids)];
      if (toolIds.length > 0) {
        await tx
          .insert(routeMcpTools)
          .values(toolIds.map((mcpToolId) => ({ routeId: row.id, mcpToolId })));
      }
      return row.id;
    });
    return await getRoute(id);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ServiceError(409, "route_slug_taken", `A route "${input.slug}" already exists`);
    }
    throw error;
  }
}

function stepValues(routeId: string, input: RouteWriteInput) {
  return input.steps.map((step, position) => ({
    routeId,
    position,
    providerId: step.provider_id,
    upstreamModel: step.upstream_model,
    timeoutMs: step.timeout_ms,
  }));
}

/** Replaces the route's fields and its ordered steps array. */
export async function updateRoute(id: string, input: RouteWriteInput): Promise<RouteView> {
  const current = await getRoute(id);
  if (current.is_default && !input.enabled) {
    throw new ServiceError(409, "default_route_disabled", "Choose another default route first");
  }
  await assertProvidersExist(input.steps.map((step) => step.provider_id));
  await assertMcpToolsAllowed(input.mcp_tool_ids);
  try {
    await getDb().transaction(async (tx) => {
      await tx
        .update(modelRoutes)
        .set({
          slug: input.slug,
          description: input.description,
          enabled: input.enabled,
          builtinTools: [...new Set(input.builtin_tools)],
          updatedAt: new Date(),
        })
        .where(eq(modelRoutes.id, id));
      await tx.delete(routeSteps).where(eq(routeSteps.routeId, id));
      await tx.insert(routeSteps).values(stepValues(id, input));
      await tx.delete(routeMcpTools).where(eq(routeMcpTools.routeId, id));
      const toolIds = [...new Set(input.mcp_tool_ids)];
      if (toolIds.length > 0) {
        await tx
          .insert(routeMcpTools)
          .values(toolIds.map((mcpToolId) => ({ routeId: id, mcpToolId })));
      }
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ServiceError(409, "route_slug_taken", `A route "${input.slug}" already exists`);
    }
    throw error;
  }
  return getRoute(id);
}

/** Makes `id` the single default route (transactional, so exactly one default exists). */
export async function setDefaultRoute(id: string): Promise<RouteView> {
  const route = await getRoute(id);
  if (!route.enabled) {
    throw new ServiceError(409, "route_disabled", "Enable the route before making it the default");
  }
  await getDb().transaction(async (tx) => {
    await tx.update(modelRoutes).set({ isDefault: false }).where(eq(modelRoutes.isDefault, true));
    await tx.update(modelRoutes).set({ isDefault: true }).where(eq(modelRoutes.id, id));
  });
  return getRoute(id);
}

export async function deleteRoute(id: string): Promise<void> {
  const route = await getRoute(id);
  if (route.is_default) {
    const all = await listRoutes();
    if (all.length > 1) {
      throw new ServiceError(
        409,
        "default_route_delete",
        "Choose another default route before deleting this one",
      );
    }
  }
  await getDb().delete(modelRoutes).where(eq(modelRoutes.id, id));
}

/** Enabled routes for `GET /v1/models`. */
export async function listEnabledRoutes(): Promise<{ slug: string; createdAt: Date }[]> {
  return getDb()
    .select({ slug: modelRoutes.slug, createdAt: modelRoutes.createdAt })
    .from(modelRoutes)
    .where(eq(modelRoutes.enabled, true))
    .orderBy(asc(modelRoutes.slug));
}

export type RouteSelector = { kind: "default" } | { kind: "slug"; slug: string };

/** `model` absent, empty or `default` selects the default route (Unity omits `model` for "default"). */
export function selectRoute(model: unknown): RouteSelector {
  if (typeof model !== "string") return { kind: "default" };
  const slug = model.trim();
  if (slug === "" || slug.toLowerCase() === "default") return { kind: "default" };
  return { kind: "slug", slug };
}

/** Loads an enabled route with decrypted provider runtimes; undefined when unknown or disabled. */
export async function resolveRoute(selector: RouteSelector): Promise<ResolvedRoute | undefined> {
  const db = getDb();
  const condition =
    selector.kind === "default"
      ? eq(modelRoutes.isDefault, true)
      : eq(modelRoutes.slug, selector.slug);
  const [route] = await db.select().from(modelRoutes).where(condition);
  if (!route?.enabled) return undefined;
  const rows = await db
    .select({ step: routeSteps, provider: providers })
    .from(routeSteps)
    .innerJoin(providers, eq(routeSteps.providerId, providers.id))
    .where(eq(routeSteps.routeId, route.id))
    .orderBy(asc(routeSteps.position));
  return {
    slug: route.slug,
    id: route.id,
    steps: rows.map(({ step, provider }) => ({
      provider: toProviderRuntime(provider),
      upstreamModel: step.upstreamModel,
      timeoutMs: step.timeoutMs,
    })),
    mcpTools: await resolveRouteMcpTools(route.id),
    builtinTools: availableBuiltinTools(route.builtinTools),
  };
}
