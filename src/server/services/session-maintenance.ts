import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { sessions } from "@/server/db/schema";
import { logger } from "@/server/logger";
import { getSessionSettings } from "@/server/services/session-settings";

/**
 * Cleanup callback for data keyed by session id that lives outside the cascading tables
 * (session memory, LangGraph checkpoints, run logs). Called with the ids about to be deleted.
 */
export type PurgeHook = (sessionIds: string[]) => Promise<void>;

const purgeHooks = new Map<string, PurgeHook>();

/** Registers (or replaces) a named purge hook. Later stages call this at startup. */
export function registerPurgeHook(name: string, hook: PurgeHook): void {
  purgeHooks.set(name, hook);
}

export function listPurgeHookNames(): string[] {
  return [...purgeHooks.keys()];
}

export function clearPurgeHooksForTests(): void {
  purgeHooks.clear();
}

const DELETE_BATCH_SIZE = 500;

/** Hard-deletes sessions (cascading to turns, items and request rows) after running purge hooks. */
export async function deleteSessionsByIds(ids: string[]): Promise<number> {
  let deleted = 0;
  for (let start = 0; start < ids.length; start += DELETE_BATCH_SIZE) {
    const batch = ids.slice(start, start + DELETE_BATCH_SIZE);
    for (const [name, hook] of purgeHooks) {
      try {
        await hook(batch);
      } catch (error) {
        logger.error("Purge hook failed", {
          hook: name,
          error: error instanceof Error ? error.message : "unknown error",
        });
      }
    }
    const rows = await getDb()
      .delete(sessions)
      .where(inArray(sessions.id, batch))
      .returning({ id: sessions.id });
    deleted += rows.length;
  }
  return deleted;
}

/** Marks active sessions idle beyond the configured timeout as expired. */
export async function expireIdleSessions(now = new Date()): Promise<number> {
  const { idle_timeout_minutes: minutes } = await getSessionSettings();
  const cutoff = new Date(now.getTime() - minutes * 60_000);
  const rows = await getDb()
    .update(sessions)
    .set({ status: "expired", endReason: "idle", endedAt: now })
    .where(and(eq(sessions.status, "active"), lt(sessions.lastActivityAt, cutoff)))
    .returning({ id: sessions.id });
  return rows.length;
}

/** Flags expired sessions with exactly one request as standalone (one-shot helper calls). */
export async function flagStandaloneSessions(): Promise<number> {
  const rows = await getDb()
    .update(sessions)
    .set({ standalone: true })
    .where(
      and(
        eq(sessions.status, "expired"),
        eq(sessions.standalone, false),
        sql`(select count(*) from llm_requests r where r.session_id = ${sessions.id}) = 1`,
        sql`${sessions.turnCount} <= 1`,
      ),
    )
    .returning({ id: sessions.id });
  return rows.length;
}

/** Deletes sessions whose last activity is older than `retention_days` (0 keeps everything). */
export async function purgeExpiredRetention(now = new Date()): Promise<number> {
  const { retention_days: days } = await getSessionSettings();
  if (days <= 0) return 0;
  const cutoff = new Date(now.getTime() - days * 86_400_000);
  const stale = await getDb()
    .select({ id: sessions.id })
    .from(sessions)
    .where(lt(sessions.lastActivityAt, cutoff));
  return deleteSessionsByIds(stale.map((row) => row.id));
}

export interface MaintenanceResult {
  expired: number;
  standalone: number;
  purged: number;
}

/** One maintenance pass: expire idle sessions, flag one-shot sessions, purge by retention. */
export async function runMaintenance(
  options: { purge?: boolean } = {},
): Promise<MaintenanceResult> {
  const expired = await expireIdleSessions();
  const standalone = await flagStandaloneSessions();
  const purged = options.purge === false ? 0 : await purgeExpiredRetention();
  return { expired, standalone, purged };
}

const SWEEP_INTERVAL_MS = 60_000;
const PURGE_INTERVAL_MS = 3_600_000;
const SCHEDULER_KEY = Symbol.for("agentx-gateway.maintenance-scheduler");

type SchedulerGlobal = typeof globalThis & { [SCHEDULER_KEY]?: NodeJS.Timeout };

/** Starts the per-minute sweeper and hourly purge. Idempotent per process. */
export function startMaintenanceScheduler(): void {
  const holder = globalThis as SchedulerGlobal;
  if (holder[SCHEDULER_KEY]) return;

  let lastPurge = 0;
  const tick = async () => {
    try {
      const purge = Date.now() - lastPurge >= PURGE_INTERVAL_MS;
      const result = await runMaintenance({ purge });
      if (purge) lastPurge = Date.now();
      if (result.expired + result.standalone + result.purged > 0) {
        logger.info("Session maintenance", { ...result });
      }
    } catch (error) {
      logger.error("Session maintenance failed", {
        error: error instanceof Error ? error.message : "unknown error",
      });
    }
  };

  const timer = setInterval(tick, SWEEP_INTERVAL_MS);
  timer.unref();
  holder[SCHEDULER_KEY] = timer;
  void tick();
}

/** Stops the scheduler (tests). */
export function stopMaintenanceScheduler(): void {
  const holder = globalThis as SchedulerGlobal;
  if (holder[SCHEDULER_KEY]) clearInterval(holder[SCHEDULER_KEY]);
  holder[SCHEDULER_KEY] = undefined;
}
