import { and, arrayOverlaps, asc, eq, inArray, sql } from "drizzle-orm";
import type { McpServerCreateInput, McpServerUpdateInput } from "@/lib/gateway-schemas";
import { decryptSecret, encryptSecret, maskSecret } from "@/server/crypto/secrets";
import { getDb } from "@/server/db/client";
import {
  type McpTransport,
  mcpPendingMessages,
  mcpServers,
  mcpTools,
  modelRoutes,
  routeMcpTools,
} from "@/server/db/schema";
import {
  listMcpServerTools,
  type McpServerRuntime,
  type McpToolInfo,
} from "@/server/gateway/mcp-client";
import { validateExposedToolName } from "@/server/gateway/mcp-names";
import { ServiceError } from "@/server/services/errors";

type ServerRow = typeof mcpServers.$inferSelect;
type ToolRow = typeof mcpTools.$inferSelect;

export interface McpHeaderMask {
  name: string;
  value: string;
}

/** Admin-facing server. Header values are write-only: only names and masked values are exposed. */
export interface McpServerView {
  id: string;
  name: string;
  slug: string;
  url: string;
  transport: McpTransport;
  enabled: boolean;
  headers_masked: McpHeaderMask[] | null;
  tool_count: number;
  allowed_tool_count: number;
  created_at: string;
  updated_at: string;
}

export interface McpToolView {
  id: string;
  server_id: string;
  server_name: string;
  server_slug: string;
  name: string;
  /** `<server_slug>__<tool>` as offered to models. */
  exposed_name: string;
  /** False when the exposed name would not be a valid OpenAI function name. */
  valid: boolean;
  description: string;
  input_schema: unknown;
  allowed: boolean;
  last_seen_at: string | null;
}

export interface McpToolTestResult {
  ok: boolean;
  duration_ms: number;
  tools?: { name: string; description: string }[];
  error?: string;
}

export function parseHeaders(encrypted: string | null): Record<string, string> {
  if (!encrypted) return {};
  return JSON.parse(decryptSecret(encrypted)) as Record<string, string>;
}

function normalizeUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: string; cause?: { code?: string } })?.code;
  const causeCode = (error as { cause?: { code?: string } })?.cause?.code;
  return code === "23505" || causeCode === "23505";
}

function hasHeaders(
  headers: Record<string, string> | null | undefined,
): headers is Record<string, string> {
  return !!headers && Object.keys(headers).length > 0;
}

function toRuntime(row: ServerRow): McpServerRuntime {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    url: normalizeUrl(row.url),
    transport: row.transport,
    headers: parseHeaders(row.headers),
  };
}

function maskedHeaders(row: ServerRow): McpHeaderMask[] | null {
  const headers = parseHeaders(row.headers);
  const entries = Object.entries(headers);
  if (entries.length === 0) return null;
  return entries.map(([name, value]) => ({ name, value: maskSecret(value) }));
}

function toToolView(tool: ToolRow, server: Pick<ServerRow, "name" | "slug">): McpToolView {
  const exposed = validateExposedToolName(server.slug, tool.name);
  return {
    id: tool.id,
    server_id: tool.serverId,
    server_name: server.name,
    server_slug: server.slug,
    name: tool.name,
    exposed_name: exposed.name,
    valid: exposed.ok,
    description: tool.description,
    input_schema: tool.inputSchema,
    allowed: tool.allowed,
    last_seen_at: tool.lastSeenAt?.toISOString() ?? null,
  };
}

async function serverRows(): Promise<ServerRow[]> {
  return getDb().select().from(mcpServers).orderBy(asc(mcpServers.name));
}

async function toolsByServer(): Promise<Map<string, ToolRow[]>> {
  const rows = await getDb().select().from(mcpTools).orderBy(asc(mcpTools.name));
  const map = new Map<string, ToolRow[]>();
  for (const row of rows) map.set(row.serverId, [...(map.get(row.serverId) ?? []), row]);
  return map;
}

export async function listMcpServers(): Promise<McpServerView[]> {
  const [servers, tools] = await Promise.all([serverRows(), toolsByServer()]);
  return servers.map((row) => {
    const serverTools = tools.get(row.id) ?? [];
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      url: row.url,
      transport: row.transport,
      enabled: row.enabled,
      headers_masked: maskedHeaders(row),
      tool_count: serverTools.length,
      allowed_tool_count: serverTools.filter((tool) => tool.allowed).length,
      created_at: row.createdAt.toISOString(),
      updated_at: row.updatedAt.toISOString(),
    };
  });
}

async function findServerRow(id: string): Promise<ServerRow> {
  const [row] = await getDb().select().from(mcpServers).where(eq(mcpServers.id, id));
  if (!row) throw new ServiceError(404, "mcp_server_not_found", "MCP server not found");
  return row;
}

export async function getMcpServer(id: string): Promise<McpServerView> {
  const row = await findServerRow(id);
  const serverTools = await getDb().select().from(mcpTools).where(eq(mcpTools.serverId, id));
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    url: row.url,
    transport: row.transport,
    enabled: row.enabled,
    headers_masked: maskedHeaders(row),
    tool_count: serverTools.length,
    allowed_tool_count: serverTools.filter((tool) => tool.allowed).length,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

export async function getMcpServerRuntime(id: string): Promise<McpServerRuntime> {
  return toRuntime(await findServerRow(id));
}

export async function createMcpServer(input: McpServerCreateInput): Promise<McpServerView> {
  try {
    const [row] = await getDb()
      .insert(mcpServers)
      .values({
        name: input.name,
        slug: input.slug,
        url: normalizeUrl(input.url),
        transport: input.transport,
        headers: hasHeaders(input.headers) ? encryptSecret(JSON.stringify(input.headers)) : null,
        enabled: input.enabled,
      })
      .returning();
    return await getMcpServer(row.id);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ServiceError(409, "mcp_server_taken", "That name or slug is already in use");
    }
    throw error;
  }
}

function definedEntries<T extends object>(partial: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(partial).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

export async function updateMcpServer(
  id: string,
  input: McpServerUpdateInput,
): Promise<McpServerView> {
  await findServerRow(id);
  const changes: Partial<typeof mcpServers.$inferInsert> = { updatedAt: new Date() };
  for (const [key, value] of Object.entries(definedEntries(input))) {
    if (key === "headers") continue;
    if (key === "url" && typeof value === "string") changes.url = normalizeUrl(value);
    else if (key === "name") changes.name = value as string;
    else if (key === "slug") changes.slug = value as string;
    else if (key === "transport") changes.transport = value as McpTransport;
    else if (key === "enabled") changes.enabled = value as boolean;
  }
  // Absent = keep; null = clear; object = replace.
  if (input.headers !== undefined) {
    changes.headers = hasHeaders(input.headers)
      ? encryptSecret(JSON.stringify(input.headers))
      : null;
  }
  try {
    await getDb().update(mcpServers).set(changes).where(eq(mcpServers.id, id));
    return await getMcpServer(id);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ServiceError(409, "mcp_server_taken", "That name or slug is already in use");
    }
    throw error;
  }
}

export async function deleteMcpServer(id: string): Promise<void> {
  await findServerRow(id);
  await getDb().delete(mcpServers).where(eq(mcpServers.id, id));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown MCP error";
}

/** Connects and lists the server's tools; never persists anything. */
export async function testMcpServer(id: string): Promise<McpToolTestResult> {
  const server = await getMcpServerRuntime(id);
  const started = performance.now();
  try {
    const tools = await listMcpServerTools(server);
    return {
      ok: true,
      duration_ms: Math.round(performance.now() - started),
      tools: tools.map((tool) => ({ name: tool.name, description: tool.description })),
    };
  } catch (error) {
    return {
      ok: false,
      duration_ms: Math.round(performance.now() - started),
      error: errorMessage(error),
    };
  }
}

/** Fetches `tools/list` and upserts every tool, preserving the allowlist. */
export async function refreshMcpTools(id: string): Promise<McpToolView[]> {
  const row = await findServerRow(id);
  const server = toRuntime(row);
  let tools: McpToolInfo[];
  try {
    tools = await listMcpServerTools(server);
  } catch (error) {
    throw new ServiceError(502, "mcp_unreachable", `Could not list tools: ${errorMessage(error)}`);
  }
  const now = new Date();
  if (tools.length > 0) {
    await getDb()
      .insert(mcpTools)
      .values(
        tools.map((tool) => ({
          serverId: id,
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          lastSeenAt: now,
        })),
      )
      .onConflictDoUpdate({
        target: [mcpTools.serverId, mcpTools.name],
        set: {
          description: sql`excluded.description`,
          inputSchema: sql`excluded.input_schema`,
          lastSeenAt: now,
        },
      });
  }
  return listMcpTools(id);
}

export async function listMcpTools(serverId?: string): Promise<McpToolView[]> {
  const rows = await getDb()
    .select({ tool: mcpTools, server: mcpServers })
    .from(mcpTools)
    .innerJoin(mcpServers, eq(mcpTools.serverId, mcpServers.id))
    .where(serverId ? eq(mcpTools.serverId, serverId) : undefined)
    .orderBy(asc(mcpServers.name), asc(mcpTools.name));
  return rows.map(({ tool, server }) => toToolView(tool, server));
}

export async function setMcpToolAllowed(id: string, allowed: boolean): Promise<McpToolView> {
  const [row] = await getDb()
    .update(mcpTools)
    .set({ allowed })
    .where(eq(mcpTools.id, id))
    .returning();
  if (!row) throw new ServiceError(404, "mcp_tool_not_found", "MCP tool not found");
  const server = await findServerRow(row.serverId);
  if (!allowed) {
    await getDb().delete(routeMcpTools).where(eq(routeMcpTools.mcpToolId, id));
  }
  return toToolView(row, server);
}

/** Rejects a selection that includes a tool which is unknown or not globally allowed. */
export async function assertMcpToolsAllowed(toolIds: string[]): Promise<void> {
  const unique = [...new Set(toolIds)];
  if (unique.length === 0) return;
  const allowed = await getDb()
    .select({ id: mcpTools.id })
    .from(mcpTools)
    .where(and(inArray(mcpTools.id, unique), eq(mcpTools.allowed, true)));
  if (allowed.length !== unique.length) {
    throw new ServiceError(
      400,
      "mcp_tool_not_allowed",
      "Every selected tool must be allowed on its server first",
    );
  }
}

/** Sets the exact MCP tool selection of a route (only tools that are globally allowed). */
export async function setRouteMcpTools(routeId: string, toolIds: string[]): Promise<void> {
  await assertMcpToolsAllowed(toolIds);
  const unique = [...new Set(toolIds)];
  await getDb().transaction(async (tx) => {
    await tx.delete(routeMcpTools).where(eq(routeMcpTools.routeId, routeId));
    if (unique.length > 0) {
      await tx.insert(routeMcpTools).values(unique.map((mcpToolId) => ({ routeId, mcpToolId })));
    }
  });
}

export async function routeMcpToolIds(routeIds: string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (routeIds.length === 0) return map;
  const rows = await getDb()
    .select({ routeId: routeMcpTools.routeId, toolId: routeMcpTools.mcpToolId })
    .from(routeMcpTools)
    .where(inArray(routeMcpTools.routeId, routeIds));
  for (const row of rows) {
    map.set(row.routeId, [...(map.get(row.routeId) ?? []), row.toolId]);
  }
  return map;
}

export interface ResolvedMcpTool {
  id: string;
  exposedName: string;
  toolName: string;
  serverSlug: string;
  description: string;
  inputSchema: unknown;
  server: McpServerRuntime;
}

/**
 * The tools a route may offer: selected on the route, allowed globally, on an enabled server,
 * with a valid OpenAI function name. Invalid names are skipped rather than breaking the route.
 */
export async function resolveRouteMcpTools(routeId: string): Promise<ResolvedMcpTool[]> {
  const rows = await getDb()
    .select({ tool: mcpTools, server: mcpServers })
    .from(routeMcpTools)
    .innerJoin(mcpTools, eq(routeMcpTools.mcpToolId, mcpTools.id))
    .innerJoin(mcpServers, eq(mcpTools.serverId, mcpServers.id))
    .where(
      and(
        eq(routeMcpTools.routeId, routeId),
        eq(mcpTools.allowed, true),
        eq(mcpServers.enabled, true),
      ),
    )
    .orderBy(asc(mcpServers.slug), asc(mcpTools.name));
  const tools: ResolvedMcpTool[] = [];
  for (const { tool, server } of rows) {
    const exposed = validateExposedToolName(server.slug, tool.name);
    if (!exposed.ok) continue;
    tools.push({
      id: tool.id,
      exposedName: exposed.name,
      toolName: tool.name,
      serverSlug: server.slug,
      description: tool.description,
      inputSchema: tool.inputSchema,
      server: toRuntime(server),
    });
  }
  return tools;
}

/** All allowed tools on enabled servers, for the route editor picker. */
export async function listAllowedMcpTools(): Promise<McpToolView[]> {
  const rows = await getDb()
    .select({ tool: mcpTools, server: mcpServers })
    .from(mcpTools)
    .innerJoin(mcpServers, eq(mcpTools.serverId, mcpServers.id))
    .where(and(eq(mcpTools.allowed, true), eq(mcpServers.enabled, true)))
    .orderBy(asc(mcpServers.name), asc(mcpTools.name));
  return rows.map(({ tool, server }) => toToolView(tool, server));
}

/**
 * Runtime resolution for LLM nodes: the selected tool ids that are still allowed on an enabled
 * server, with a valid exposed name. Unknown/blocked ids are silently dropped by design.
 */
export async function resolveMcpToolsByIds(ids: string[]): Promise<ResolvedMcpTool[]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  const rows = await getDb()
    .select({ tool: mcpTools, server: mcpServers })
    .from(mcpTools)
    .innerJoin(mcpServers, eq(mcpTools.serverId, mcpServers.id))
    .where(
      and(inArray(mcpTools.id, unique), eq(mcpTools.allowed, true), eq(mcpServers.enabled, true)),
    )
    .orderBy(asc(mcpServers.slug), asc(mcpTools.name));
  const tools: ResolvedMcpTool[] = [];
  for (const { tool, server } of rows) {
    const exposed = validateExposedToolName(server.slug, tool.name);
    if (!exposed.ok) continue;
    tools.push({
      id: tool.id,
      exposedName: exposed.name,
      toolName: tool.name,
      serverSlug: server.slug,
      description: tool.description,
      inputSchema: tool.inputSchema,
      server: toRuntime(server),
    });
  }
  return tools;
}

/** Runtime resolution for MCP Tool nodes: one allowed tool on an enabled server. */
export async function resolveMcpToolForCall(
  serverId: string,
  toolName: string,
): Promise<{ server: McpServerRuntime; toolName: string } | undefined> {
  const [row] = await getDb()
    .select({ tool: mcpTools, server: mcpServers })
    .from(mcpTools)
    .innerJoin(mcpServers, eq(mcpTools.serverId, mcpServers.id))
    .where(
      and(
        eq(mcpTools.serverId, serverId),
        eq(mcpTools.name, toolName),
        eq(mcpTools.allowed, true),
        eq(mcpServers.enabled, true),
      ),
    );
  if (!row) return undefined;
  return { server: toRuntime(row.server), toolName: row.tool.name };
}

export async function routeSlugExists(routeId: string): Promise<string> {
  const [row] = await getDb()
    .select({ slug: modelRoutes.slug })
    .from(modelRoutes)
    .where(eq(modelRoutes.id, routeId));
  if (!row) throw new ServiceError(404, "route_not_found", "Route not found");
  return row.slug;
}

/** Pending mixed-round messages triggered by the client tool results now in the request. */
export async function takePendingMcpMessages(
  sessionId: string,
  clientToolCallIds: string[],
): Promise<unknown[]> {
  if (clientToolCallIds.length === 0) return [];
  const db = getDb();
  const rows = await db
    .select()
    .from(mcpPendingMessages)
    .where(
      and(
        eq(mcpPendingMessages.sessionId, sessionId),
        arrayOverlaps(mcpPendingMessages.clientToolCallIds, clientToolCallIds),
      ),
    )
    .orderBy(asc(mcpPendingMessages.createdAt));
  if (rows.length === 0) return [];
  await db.delete(mcpPendingMessages).where(
    inArray(
      mcpPendingMessages.id,
      rows.map((row) => row.id),
    ),
  );
  return rows.flatMap((row) => row.messages);
}

export async function savePendingMcpMessages(
  sessionId: string,
  clientToolCallIds: string[],
  messages: unknown[],
): Promise<void> {
  if (clientToolCallIds.length === 0 || messages.length === 0) return;
  await getDb().insert(mcpPendingMessages).values({ sessionId, clientToolCallIds, messages });
}
