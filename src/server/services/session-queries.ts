import { and, asc, desc, eq, gte, inArray, lte, type SQL, sql } from "drizzle-orm";
import type { SessionFiltersInput } from "@/lib/gateway-schemas";
import type {
  LinkedRequestView,
  SessionDetail,
  SessionListResponse,
  SessionSummary,
  TranscriptItemView,
  TurnView,
} from "@/lib/session-types";
import { getDb } from "@/server/db/client";
import {
  apiKeys,
  llmRequests,
  providers,
  sessions,
  transcriptItems,
  turns,
} from "@/server/db/schema";
import { ServiceError } from "@/server/services/errors";
import { listRunLogs, listSessionMemory } from "@/server/services/run-logs";
import { deleteSessionsByIds } from "@/server/services/session-maintenance";

export type SessionFilters = Partial<SessionFiltersInput>;

const SORT_COLUMNS = {
  started_at: sessions.startedAt,
  last_activity_at: sessions.lastActivityAt,
  turn_count: sessions.turnCount,
  status: sessions.status,
} as const;

export type SessionSortKey = keyof typeof SORT_COLUMNS;
export const SESSION_SORT_KEYS = Object.keys(SORT_COLUMNS) as SessionSortKey[];

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Builds the WHERE clause shared by the list, the bulk exports and the bulk delete. */
export function buildSessionConditions(filters: SessionFilters): SQL | undefined {
  const conditions: SQL[] = [];
  if (filters.status) conditions.push(eq(sessions.status, filters.status));
  if (filters.api_key_id) conditions.push(eq(sessions.apiKeyId, filters.api_key_id));
  if (filters.route) conditions.push(eq(sessions.routeSlug, filters.route));
  if (filters.agent) conditions.push(eq(sessions.agentId, filters.agent));
  if (filters.from) conditions.push(gte(sessions.startedAt, new Date(filters.from)));
  if (filters.to) conditions.push(lte(sessions.startedAt, new Date(filters.to)));
  if (!filters.include_standalone) conditions.push(eq(sessions.standalone, false));
  if (filters.q) {
    conditions.push(
      sql`exists (select 1 from ${transcriptItems} where ${transcriptItems.sessionId} = ${sessions.id} and ${transcriptItems.search} @@ websearch_to_tsquery('english', ${filters.q}))`,
    );
  }
  return conditions.length > 0 ? and(...conditions) : undefined;
}

type SummaryRow = {
  session: typeof sessions.$inferSelect;
  apiKeyLabel: string | null;
};

function toSummary({ session, apiKeyLabel }: SummaryRow): SessionSummary {
  return {
    id: session.id,
    api_key_id: session.apiKeyId,
    api_key_label: apiKeyLabel,
    route_slug: session.routeSlug,
    agent_id: session.agentId,
    agent_version: session.agentVersion,
    status: session.status,
    end_reason: session.endReason,
    standalone: session.standalone,
    started_at: session.startedAt.toISOString(),
    last_activity_at: session.lastActivityAt.toISOString(),
    ended_at: session.endedAt?.toISOString() ?? null,
    turn_count: session.turnCount,
  };
}

export interface ListSessionsOptions {
  filters: SessionFilters;
  page: number;
  pageSize: number;
  sort: SessionSortKey;
  direction: "asc" | "desc";
}

export async function listSessions(options: ListSessionsOptions): Promise<SessionListResponse> {
  const db = getDb();
  const where = buildSessionConditions(options.filters);
  const column = SORT_COLUMNS[options.sort];
  const order = options.direction === "asc" ? asc(column) : desc(column);

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({ session: sessions, apiKeyLabel: apiKeys.label })
      .from(sessions)
      .leftJoin(apiKeys, eq(apiKeys.id, sessions.apiKeyId))
      .where(where)
      .orderBy(order, desc(sessions.id))
      .limit(options.pageSize)
      .offset((options.page - 1) * options.pageSize),
    db.select({ total: sql<number>`count(*)::int` }).from(sessions).where(where),
  ]);

  return {
    data: rows.map(toSummary),
    total,
    page: options.page,
    page_size: options.pageSize,
  };
}

function toItemView(row: typeof transcriptItems.$inferSelect): TranscriptItemView {
  return {
    id: row.id,
    turn_id: row.turnId,
    seq: row.seq,
    kind: row.kind,
    content: row.content,
    tool_call_id: row.toolCallId,
    tool_name: row.toolName,
    tool_args: row.toolArgs ?? null,
    tool_source: row.toolSource,
    duration_ms: row.durationMs,
    llm_request_id: row.llmRequestId,
    created_at: row.createdAt.toISOString(),
  };
}

function toRequestView(
  row: typeof llmRequests.$inferSelect,
  providerName: string | null,
): LinkedRequestView {
  return {
    id: row.id,
    turn_id: row.turnId,
    route_slug: row.routeSlug,
    provider_id: row.providerId,
    provider_name: providerName,
    upstream_model: row.upstreamModel,
    stream: row.stream,
    client_api: row.clientApi,
    upstream_api: row.upstreamApi,
    status: row.status,
    http_status: row.httpStatus,
    error_code: row.errorCode,
    started_at: row.startedAt.toISOString(),
    duration_ms: row.durationMs,
    ttft_ms: row.ttftMs,
    attempts: row.attempts,
    usage: row.usage,
  };
}

/** Session with its turns, transcript items and linked request rows; undefined when unknown. */
export async function findSessionDetail(id: string): Promise<SessionDetail | undefined> {
  if (!UUID_PATTERN.test(id)) return undefined;
  const db = getDb();
  const [row] = await db
    .select({ session: sessions, apiKeyLabel: apiKeys.label })
    .from(sessions)
    .leftJoin(apiKeys, eq(apiKeys.id, sessions.apiKeyId))
    .where(eq(sessions.id, id));
  if (!row) return undefined;

  const [turnRows, itemRows, requestRows] = await Promise.all([
    db.select().from(turns).where(eq(turns.sessionId, id)).orderBy(asc(turns.seq)),
    db
      .select()
      .from(transcriptItems)
      .where(eq(transcriptItems.sessionId, id))
      .orderBy(asc(transcriptItems.seq)),
    db
      .select({ request: llmRequests, providerName: providers.name })
      .from(llmRequests)
      .leftJoin(providers, eq(providers.id, llmRequests.providerId))
      .where(eq(llmRequests.sessionId, id))
      .orderBy(asc(llmRequests.startedAt)),
  ]);
  const [runLogRows, memoryRows] = await Promise.all([listRunLogs(id), listSessionMemory(id)]);

  const turnViews: TurnView[] = turnRows.map((turn) => ({
    id: turn.id,
    seq: turn.seq,
    started_at: turn.startedAt.toISOString(),
    completed_at: turn.completedAt?.toISOString() ?? null,
    items: itemRows.filter((item) => item.turnId === turn.id).map(toItemView),
    requests: requestRows
      .filter((entry) => entry.request.turnId === turn.id)
      .map((entry) => toRequestView(entry.request, entry.providerName)),
  }));

  return {
    ...toSummary(row),
    system_prompt_hash: row.session.systemPromptHash,
    turns: turnViews,
    run_logs: runLogRows,
    memory: memoryRows,
  };
}

export async function getSessionDetail(id: string): Promise<SessionDetail> {
  const detail = await findSessionDetail(id);
  if (!detail) throw new ServiceError(404, "not_found", "Session not found");
  return detail;
}

/** Ids matching a filter set (or an explicit id list), newest first, in pages for streaming. */
export async function* iterateSessionIds(
  selection: { ids: string[] } | { filters: SessionFilters },
  batchSize = 100,
): AsyncGenerator<string[]> {
  const db = getDb();
  if ("ids" in selection) {
    for (let start = 0; start < selection.ids.length; start += batchSize) {
      const batch = selection.ids.slice(start, start + batchSize);
      const rows = await db
        .select({ id: sessions.id })
        .from(sessions)
        .where(inArray(sessions.id, batch))
        .orderBy(desc(sessions.startedAt));
      yield rows.map((row) => row.id);
    }
    return;
  }
  const where = buildSessionConditions(selection.filters);
  for (let offset = 0; ; offset += batchSize) {
    const rows = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(where)
      .orderBy(desc(sessions.startedAt), desc(sessions.id))
      .limit(batchSize)
      .offset(offset);
    if (rows.length === 0) return;
    yield rows.map((row) => row.id);
    if (rows.length < batchSize) return;
  }
}

/** Hard-deletes one session. */
export async function deleteSession(id: string): Promise<void> {
  if (!UUID_PATTERN.test(id) || (await deleteSessionsByIds([id])) === 0) {
    throw new ServiceError(404, "not_found", "Session not found");
  }
}

/** Hard-deletes by explicit ids or by filters (for example a date range). Returns the count. */
export async function deleteSessionsBySelection(
  selection: { ids: string[] } | { filters: SessionFilters },
): Promise<number> {
  const ids: string[] = [];
  for await (const batch of iterateSessionIds(selection, 500)) ids.push(...batch);
  return deleteSessionsByIds(ids);
}
