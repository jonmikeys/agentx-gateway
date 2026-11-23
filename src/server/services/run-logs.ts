import { desc, eq } from "drizzle-orm";
import type { RunLogView, RunTrace, SessionMemoryView } from "@/lib/agents/types";
import { getDb } from "@/server/db/client";
import { flows, runLogs, sessionMemory } from "@/server/db/schema";

export interface RecordRunLogInput {
  sessionId: string | null;
  turnId: string | null;
  flowId: string;
  version: number;
  trace: RunTrace;
  status: "ok" | "error";
  startedAt: Date;
  durationMs: number;
}

/** Persists one production agent run so the transcript viewer can show its trace. */
export async function recordRunLog(input: RecordRunLogInput): Promise<string> {
  const [row] = await getDb()
    .insert(runLogs)
    .values({
      sessionId: input.sessionId,
      turnId: input.turnId,
      flowId: input.flowId,
      version: input.version,
      trace: input.trace,
      status: input.status,
      startedAt: input.startedAt,
      durationMs: input.durationMs,
    })
    .returning({ id: runLogs.id });
  return row.id;
}

export async function listRunLogs(sessionId: string): Promise<RunLogView[]> {
  const rows = await getDb()
    .select({ log: runLogs, flowName: flows.name })
    .from(runLogs)
    .leftJoin(flows, eq(flows.id, runLogs.flowId))
    .where(eq(runLogs.sessionId, sessionId))
    .orderBy(desc(runLogs.startedAt));
  return rows.map(({ log, flowName }) => ({
    id: log.id,
    session_id: log.sessionId,
    turn_id: log.turnId,
    flow_id: log.flowId,
    version: log.version,
    flow_name: flowName,
    status: log.status,
    started_at: log.startedAt.toISOString(),
    duration_ms: log.durationMs,
    trace: log.trace ?? null,
  }));
}

export async function listSessionMemory(sessionId: string): Promise<SessionMemoryView[]> {
  const rows = await getDb()
    .select()
    .from(sessionMemory)
    .where(eq(sessionMemory.sessionId, sessionId));
  return rows
    .map((row) => ({
      key: row.key,
      value: row.value ?? null,
      updated_at: row.updatedAt.toISOString(),
    }))
    .sort((left, right) => left.key.localeCompare(right.key));
}
