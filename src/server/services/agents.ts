import { randomBytes } from "node:crypto";
import { and, asc, desc, eq, isNotNull } from "drizzle-orm";
import type { FlowCreateInput, FlowUpdateInput } from "@/lib/agent-schemas";
import type { ClientToolRestrictions } from "@/lib/agents/client-tools";
import { type FlowGraph, type FlowNode, flowGraphSchema, starterGraph } from "@/lib/agents/graph";
import {
  DEFAULT_FLOW_SETTINGS,
  type FlowDetail,
  type FlowSettings,
  type FlowSummary,
  type FlowVersionDetail,
  type FlowVersionSummary,
} from "@/lib/agents/types";
import { type ValidationProblem, validateGraph } from "@/lib/agents/validate";
import { decryptSecret, encryptSecret, maskSecret } from "@/server/crypto/secrets";
import { getDb } from "@/server/db/client";
import { flows, flowVersions, flowWebhookSecrets, mediaItems } from "@/server/db/schema";
import { ServiceError } from "@/server/services/errors";

const FLOW_ID_PATTERN = /^agt_[a-f0-9]{12}$/;

type FlowRow = typeof flows.$inferSelect;
type VersionRow = typeof flowVersions.$inferSelect;

export function newFlowId(): string {
  return `agt_${randomBytes(6).toString("hex")}`;
}

export function isFlowId(value: string): boolean {
  return FLOW_ID_PATTERN.test(value);
}

/** Lowercase slug derived from a display name. */
export function slugifyFlowName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "agent";
}

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: string })?.code;
  const causeCode = (error as { cause?: { code?: string } })?.cause?.code;
  return code === "23505" || causeCode === "23505";
}

function normalizeSettings(
  input: Partial<FlowSettings> | undefined,
  base = DEFAULT_FLOW_SETTINGS,
): FlowSettings {
  return {
    default_route_slug: input?.default_route_slug ?? base.default_route_slug,
    allowed_media_tags: input?.allowed_media_tags ?? base.allowed_media_tags,
    allowed_cameras: input?.allowed_cameras ?? base.allowed_cameras,
  };
}

/**
 * Resolves the agent's allowed media/camera sets into ids for the runtime and validation.
 * `null` means the agent does not restrict that catalogue; an empty array means nothing matches.
 */
export async function resolveAgentRestrictions(
  settings: FlowSettings,
): Promise<ClientToolRestrictions> {
  let mediaIds: string[] | null = null;
  const tags = settings.allowed_media_tags ?? [];
  if (tags.length > 0) {
    const rows = await getDb()
      .select({ id: mediaItems.id, tags: mediaItems.tags, enabled: mediaItems.enabled })
      .from(mediaItems);
    const allowed = new Set(tags);
    mediaIds = rows
      .filter((row) => row.enabled && row.tags.some((tag) => allowed.has(tag)))
      .map((row) => row.id);
  }
  const cameras = settings.allowed_cameras ?? [];
  return { mediaIds, cameraIds: cameras.length > 0 ? [...cameras] : null };
}

/** Removes write-only values and display masks before a graph is persisted. */
export function stripGraphSecrets(graph: FlowGraph): FlowGraph {
  const copy = structuredClone(graph);
  for (const node of copy.nodes) {
    if (node.type !== "webhook") continue;
    node.data.headers = node.data.headers.map((header) => ({ name: header.name }));
  }
  return copy;
}

function nodeCount(graph: FlowGraph): number {
  return Array.isArray(graph.nodes) ? graph.nodes.length : 0;
}

function toSummary(row: FlowRow): FlowSummary {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    slug: row.slug,
    description: row.description,
    enabled: row.enabled,
    settings: normalizeSettings(row.settings),
    published_version: row.publishedVersion,
    draft_updated_at: row.draftUpdatedAt.toISOString(),
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    node_count: nodeCount(row.draft),
  };
}

async function findRow(id: string): Promise<FlowRow> {
  const [row] = await getDb().select().from(flows).where(eq(flows.id, id));
  if (!row) throw new ServiceError(404, "flow_not_found", "Chatflow not found");
  return row;
}

/** Masked webhook header values per node, keyed `nodeId/name`. */
async function maskedHeaders(flowId: string): Promise<Map<string, string>> {
  const rows = await getDb()
    .select()
    .from(flowWebhookSecrets)
    .where(eq(flowWebhookSecrets.flowId, flowId));
  const map = new Map<string, string>();
  for (const row of rows) {
    map.set(`${row.nodeId}/${row.name}`, maskSecret(decryptSecret(row.value)));
  }
  return map;
}

/** The draft with masked header values merged in for the editor (values stay write-only). */
export async function getFlowDraft(id: string): Promise<FlowGraph> {
  const row = await findRow(id);
  const masks = await maskedHeaders(id);
  const graph = structuredClone(row.draft);
  for (const node of graph.nodes) {
    if (node.type !== "webhook") continue;
    node.data.headers = node.data.headers.map((header) => {
      const masked = masks.get(`${node.id}/${header.name}`);
      return masked ? { name: header.name, masked } : { name: header.name };
    });
  }
  return graph;
}

export async function listFlows(): Promise<FlowSummary[]> {
  const rows = await getDb().select().from(flows).orderBy(asc(flows.name));
  return rows.map(toSummary);
}

export async function getFlow(id: string): Promise<FlowDetail> {
  const row = await findRow(id);
  const [latest] = await getDb()
    .select({ version: flowVersions.version })
    .from(flowVersions)
    .where(eq(flowVersions.flowId, id))
    .orderBy(desc(flowVersions.version))
    .limit(1);
  return {
    ...toSummary(row),
    draft: await getFlowDraft(id),
    version_count: latest?.version ?? 0,
  };
}

export async function createFlow(input: FlowCreateInput): Promise<FlowDetail> {
  const id = newFlowId();
  const slug = input.slug ?? slugifyFlowName(input.name);
  try {
    await getDb()
      .insert(flows)
      .values({
        id,
        kind: input.kind,
        name: input.name,
        slug,
        description: input.description,
        enabled: input.enabled,
        settings: normalizeSettings(input.settings),
        draft: starterGraph(),
      });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ServiceError(
        409,
        "flow_slug_taken",
        `A chatflow with slug "${slug}" already exists`,
      );
    }
    throw error;
  }
  return getFlow(id);
}

export async function updateFlow(id: string, input: FlowUpdateInput): Promise<FlowDetail> {
  const row = await findRow(id);
  const changes: Partial<typeof flows.$inferInsert> = { updatedAt: new Date() };
  if (input.name !== undefined) changes.name = input.name;
  if (input.description !== undefined) changes.description = input.description;
  if (input.enabled !== undefined) changes.enabled = input.enabled;
  if (input.settings !== undefined)
    changes.settings = normalizeSettings(input.settings, row.settings);
  if (input.slug !== undefined && input.slug !== row.slug) {
    if (row.publishedVersion !== null) {
      throw new ServiceError(
        409,
        "flow_slug_fixed",
        "The slug is fixed once the chatflow is published",
      );
    }
    changes.slug = input.slug;
  }
  try {
    await getDb().update(flows).set(changes).where(eq(flows.id, id));
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ServiceError(409, "flow_slug_taken", "That slug is already in use");
    }
    throw error;
  }
  return getFlow(id);
}

async function uniqueSlug(base: string): Promise<string> {
  const existing = new Set(
    (await getDb().select({ slug: flows.slug }).from(flows)).map((entry) => entry.slug),
  );
  let candidate = base.slice(0, 56);
  let suffix = 2;
  while (existing.has(candidate)) {
    candidate = `${base.slice(0, 52)}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

export async function duplicateFlow(id: string): Promise<FlowDetail> {
  const row = await findRow(id);
  const newId = newFlowId();
  const slug = await uniqueSlug(`${row.slug}-copy`);
  await getDb()
    .insert(flows)
    .values({
      id: newId,
      kind: row.kind,
      name: `${row.name} copy`.slice(0, 120),
      slug,
      description: row.description,
      enabled: false,
      settings: normalizeSettings(row.settings),
      draft: structuredClone(row.draft),
    });
  const secrets = await getDb()
    .select()
    .from(flowWebhookSecrets)
    .where(eq(flowWebhookSecrets.flowId, id));
  if (secrets.length > 0) {
    await getDb()
      .insert(flowWebhookSecrets)
      .values(
        secrets.map((secret) => ({
          flowId: newId,
          nodeId: secret.nodeId,
          name: secret.name,
          value: secret.value,
        })),
      );
  }
  return getFlow(newId);
}

export async function deleteFlow(id: string): Promise<void> {
  await findRow(id);
  await getDb().delete(flows).where(eq(flows.id, id));
}

/** Replaces the webhook header secrets referenced by the graph (values present on the node). */
async function syncWebhookSecrets(flowId: string, graph: FlowGraph): Promise<FlowGraph> {
  const db = getDb();
  const webhookNodes = graph.nodes.filter(
    (node): node is Extract<FlowNode, { type: "webhook" }> => node.type === "webhook",
  );
  const keep = new Set<string>();
  for (const node of webhookNodes) {
    for (const header of node.data.headers) {
      keep.add(`${node.id}/${header.name}`);
      if (header.value === undefined || header.value === "") continue;
      await db
        .insert(flowWebhookSecrets)
        .values({ flowId, nodeId: node.id, name: header.name, value: encryptSecret(header.value) })
        .onConflictDoUpdate({
          target: [flowWebhookSecrets.flowId, flowWebhookSecrets.nodeId, flowWebhookSecrets.name],
          set: { value: encryptSecret(header.value), updatedAt: new Date() },
        });
    }
  }
  const existing = await db
    .select()
    .from(flowWebhookSecrets)
    .where(eq(flowWebhookSecrets.flowId, flowId));
  for (const secret of existing) {
    if (keep.has(`${secret.nodeId}/${secret.name}`)) continue;
    await db
      .delete(flowWebhookSecrets)
      .where(
        and(
          eq(flowWebhookSecrets.flowId, flowId),
          eq(flowWebhookSecrets.nodeId, secret.nodeId),
          eq(flowWebhookSecrets.name, secret.name),
        ),
      );
  }
  return stripGraphSecrets(graph);
}

export interface DraftSaveResult {
  draft_updated_at: string;
  /** True when another save happened after the client's copy. The save still wins. */
  conflict: boolean;
  draft: FlowGraph;
}

/** Autosave: last save wins; a newer stored `draft_updated_at` than the client's returns a warning. */
export async function saveDraft(
  id: string,
  graph: FlowGraph,
  baseDraftUpdatedAt?: string,
): Promise<DraftSaveResult> {
  const row = await findRow(id);
  const parsed = flowGraphSchema.safeParse(graph);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ServiceError(
      400,
      "validation_error",
      `${issue?.path.join(".") || "graph"}: ${issue?.message ?? "invalid graph"}`,
    );
  }
  const stored = await syncWebhookSecrets(id, parsed.data);
  const now = new Date();
  const conflict =
    baseDraftUpdatedAt !== undefined &&
    row.draftUpdatedAt.getTime() > new Date(baseDraftUpdatedAt).getTime();
  await getDb()
    .update(flows)
    .set({ draft: stored, draftUpdatedAt: now, updatedAt: now })
    .where(eq(flows.id, id));
  return {
    draft_updated_at: now.toISOString(),
    conflict,
    draft: await getFlowDraft(id),
  };
}

export interface PublishResult {
  version: number;
  published_at: string;
  note: string;
}

/** Validates the draft and stores the next immutable version. */
export async function publishFlow(id: string, note: string): Promise<PublishResult> {
  const row = await findRow(id);
  const restrictions = await resolveAgentRestrictions(normalizeSettings(row.settings));
  const validation = validateGraph(row.draft, restrictions);
  if (!validation.valid) {
    throw new ServiceError(
      400,
      "flow_invalid",
      "The chatflow has validation problems",
      validation.problems,
    );
  }
  const version = (row.publishedVersion ?? 0) + 1;
  const publishedAt = new Date();
  await getDb().transaction(async (tx) => {
    await tx.insert(flowVersions).values({
      flowId: id,
      version,
      graph: row.draft,
      note,
      publishedAt,
    });
    await tx
      .update(flows)
      .set({ publishedVersion: version, updatedAt: publishedAt })
      .where(eq(flows.id, id));
  });
  return { version, published_at: publishedAt.toISOString(), note };
}

export async function validateFlowDraft(
  id: string,
  graph?: FlowGraph,
): Promise<{ valid: boolean; problems: ValidationProblem[] }> {
  const row = await findRow(id);
  const draft = graph ?? row.draft;
  const restrictions = await resolveAgentRestrictions(normalizeSettings(row.settings));
  return validateGraph(draft, restrictions);
}

function toVersionSummary(row: VersionRow, graph: FlowGraph): FlowVersionSummary {
  return {
    flow_id: row.flowId,
    version: row.version,
    note: row.note,
    published_at: row.publishedAt.toISOString(),
    node_count: nodeCount(graph),
  };
}

export async function listVersions(flowId: string): Promise<FlowVersionSummary[]> {
  await findRow(flowId);
  const rows = await getDb()
    .select()
    .from(flowVersions)
    .where(eq(flowVersions.flowId, flowId))
    .orderBy(desc(flowVersions.version));
  return rows.map((row) => toVersionSummary(row, row.graph));
}

export async function getVersion(flowId: string, version: number): Promise<FlowVersionDetail> {
  const [row] = await getDb()
    .select()
    .from(flowVersions)
    .where(and(eq(flowVersions.flowId, flowId), eq(flowVersions.version, version)));
  if (!row) throw new ServiceError(404, "flow_version_not_found", "Version not found");
  return { ...toVersionSummary(row, row.graph), graph: row.graph };
}

/** Restores a published version into the draft (publishing it again creates a new version). */
export async function restoreVersion(flowId: string, version: number): Promise<FlowDetail> {
  const published = await getVersion(flowId, version);
  const now = new Date();
  await getDb()
    .update(flows)
    .set({ draft: structuredClone(published.graph), draftUpdatedAt: now, updatedAt: now })
    .where(eq(flows.id, flowId));
  return getFlow(flowId);
}

export interface ResolvedAgent {
  flow: FlowRow;
  version: number;
  graph: FlowGraph;
}

/** An enabled flow with at least one published version; undefined when unknown or not live. */
export async function resolvePublishedAgent(idOrSlug: string): Promise<ResolvedAgent | undefined> {
  const db = getDb();
  const [byId] = await db
    .select()
    .from(flows)
    .where(and(eq(flows.id, idOrSlug), eq(flows.enabled, true), isNotNull(flows.publishedVersion)));
  const row = byId ?? (await findPublishedBySlug(idOrSlug));
  if (!row || row.publishedVersion === null) return undefined;
  const [version] = await db
    .select()
    .from(flowVersions)
    .where(and(eq(flowVersions.flowId, row.id), eq(flowVersions.version, row.publishedVersion)));
  if (!version) return undefined;
  return { flow: row, version: version.version, graph: version.graph };
}

async function findPublishedBySlug(slug: string): Promise<FlowRow | undefined> {
  const [row] = await getDb()
    .select()
    .from(flows)
    .where(and(eq(flows.slug, slug), eq(flows.enabled, true), isNotNull(flows.publishedVersion)));
  return row;
}

/** Published, enabled agents for `GET /v1/agents` and the `agent:<id>` model entries. */
export async function listPublishedAgents(): Promise<
  { id: string; name: string; description: string; createdAt: Date }[]
> {
  return getDb()
    .select({
      id: flows.id,
      name: flows.name,
      description: flows.description,
      createdAt: flows.createdAt,
    })
    .from(flows)
    .where(and(eq(flows.enabled, true), isNotNull(flows.publishedVersion)))
    .orderBy(asc(flows.name));
}

/** Decrypted webhook header values for one node (runtime only; never returned by the admin API). */
export async function webhookHeaderValues(
  flowId: string,
  nodeId: string,
): Promise<Record<string, string>> {
  const rows = await getDb()
    .select()
    .from(flowWebhookSecrets)
    .where(and(eq(flowWebhookSecrets.flowId, flowId), eq(flowWebhookSecrets.nodeId, nodeId)));
  return Object.fromEntries(rows.map((row) => [row.name, decryptSecret(row.value)]));
}
