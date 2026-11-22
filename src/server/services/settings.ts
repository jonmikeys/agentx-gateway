import { eq } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { settings } from "@/server/db/schema";

/** Reads a JSON setting; returns `fallback` when unset. */
export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const [row] = await getDb().select().from(settings).where(eq(settings.key, key));
  return row ? (row.value as T) : fallback;
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  await getDb()
    .insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
}
