import { inArray, sql } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { runLogs, sessionMemory } from "@/server/db/schema";
import { logger } from "@/server/logger";
import { registerPurgeHook } from "@/server/services/session-maintenance";

/**
 * Session-keyed agent data lives outside the cascading transcript tables: run logs, session
 * memory and the LangGraph checkpoints (`thread_id` = session id). This hook clears all three on
 * every hard delete and on the retention purge (docs/sessions-and-transcripts.md).
 */
const HOOK_NAME = "agent-session-data";

async function checkpointsExist(): Promise<boolean> {
  const rows = await getDb().execute(
    sql`select to_regclass('public.checkpoints') as table_name, to_regclass('public.checkpoint_blobs') as blobs, to_regclass('public.checkpoint_writes') as writes`,
  );
  const [row] = rows as unknown as {
    table_name: string | null;
    blobs: string | null;
    writes: string | null;
  }[];
  return Boolean(row?.table_name && row?.blobs && row?.writes);
}

async function deleteCheckpoints(ids: string[]): Promise<void> {
  if (!(await checkpointsExist())) return;
  await getDb().execute(sql`delete from checkpoint_writes where thread_id = any(${ids})`);
  await getDb().execute(sql`delete from checkpoint_blobs where thread_id = any(${ids})`);
  await getDb().execute(sql`delete from checkpoints where thread_id = any(${ids})`);
}

export function registerAgentPurgeHooks(): void {
  registerPurgeHook(HOOK_NAME, async (sessionIds) => {
    if (sessionIds.length === 0) return;
    await getDb().delete(runLogs).where(inArray(runLogs.sessionId, sessionIds));
    await getDb().delete(sessionMemory).where(inArray(sessionMemory.sessionId, sessionIds));
    try {
      await deleteCheckpoints(sessionIds);
    } catch (error) {
      // A missing checkpoint schema (no agent run in this database yet) is not an error.
      logger.warn("Checkpoint purge skipped", {
        error: error instanceof Error ? error.message : "unknown error",
      });
    }
  });
}
