import { and, eq, lt, sql } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { rateCounters } from "@/server/db/schema";

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const CLEANUP_INTERVAL_MS = 3_600_000;

let lastCleanup = 0;

export function minuteWindowStart(now: Date): Date {
  return new Date(Math.floor(now.getTime() / MINUTE_MS) * MINUTE_MS);
}

/** Day windows are UTC days. */
export function dayWindowStart(now: Date): Date {
  return new Date(Math.floor(now.getTime() / DAY_MS) * DAY_MS);
}

export function secondsUntilNextMinute(now: Date): number {
  return Math.max(
    1,
    Math.ceil((minuteWindowStart(now).getTime() + MINUTE_MS - now.getTime()) / 1000),
  );
}

export function secondsUntilNextDay(now: Date): number {
  return Math.max(1, Math.ceil((dayWindowStart(now).getTime() + DAY_MS - now.getTime()) / 1000));
}

/** Atomically increments a window counter and returns the new value. */
export async function incrementCounter(
  apiKeyId: string,
  windowKind: "minute" | "day",
  windowStart: Date,
  amount = 1,
): Promise<number> {
  const [row] = await getDb()
    .insert(rateCounters)
    .values({ apiKeyId, windowKind, windowStart, count: amount })
    .onConflictDoUpdate({
      target: [rateCounters.apiKeyId, rateCounters.windowKind, rateCounters.windowStart],
      set: { count: sql`${rateCounters.count} + ${amount}` },
    })
    .returning({ count: rateCounters.count });
  void cleanupOldCounters();
  return row.count;
}

export async function readCounter(
  apiKeyId: string,
  windowKind: "minute" | "day",
  windowStart: Date,
): Promise<number> {
  const [row] = await getDb()
    .select({ count: rateCounters.count })
    .from(rateCounters)
    .where(
      and(
        eq(rateCounters.apiKeyId, apiKeyId),
        eq(rateCounters.windowKind, windowKind),
        eq(rateCounters.windowStart, windowStart),
      ),
    );
  return row?.count ?? 0;
}

/** Deletes counters older than two days (at most once an hour per process). */
async function cleanupOldCounters(): Promise<void> {
  const now = Date.now();
  if (now - lastCleanup < CLEANUP_INTERVAL_MS) return;
  lastCleanup = now;
  try {
    await getDb()
      .delete(rateCounters)
      .where(lt(rateCounters.windowStart, new Date(now - 2 * DAY_MS)));
  } catch {
    // Housekeeping only; the next interval retries.
  }
}
