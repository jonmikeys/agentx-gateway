import { and, eq } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { sessionMemory } from "@/server/db/schema";

/** Session memory storage used by Memory nodes; `jsonb` values keep strings and structures distinct. */
export interface MemoryStore {
  load(sessionId: string): Promise<Record<string, unknown>>;
  set(sessionId: string, key: string, value: unknown): Promise<void>;
  append(sessionId: string, key: string, value: unknown): Promise<unknown>;
  remove(sessionId: string, key: string): Promise<void>;
}

export const databaseMemoryStore: MemoryStore = {
  async load(sessionId) {
    const rows = await getDb()
      .select()
      .from(sessionMemory)
      .where(eq(sessionMemory.sessionId, sessionId));
    return Object.fromEntries(rows.map((row) => [row.key, row.value]));
  },

  async set(sessionId, key, value) {
    await getDb()
      .insert(sessionMemory)
      .values({ sessionId, key, value })
      .onConflictDoUpdate({
        target: [sessionMemory.sessionId, sessionMemory.key],
        set: { value, updatedAt: new Date() },
      });
  },

  async append(sessionId, key, value) {
    const [existing] = await getDb()
      .select()
      .from(sessionMemory)
      .where(and(eq(sessionMemory.sessionId, sessionId), eq(sessionMemory.key, key)));
    const previous = existing?.value;
    let next: unknown;
    if (Array.isArray(previous)) next = [...previous, value];
    else if (previous === undefined || previous === null) next = value;
    else if (typeof previous === "string" && typeof value === "string")
      next = `${previous}\n${value}`;
    else next = value;
    await databaseMemoryStore.set(sessionId, key, next);
    return next;
  },

  async remove(sessionId, key) {
    await getDb()
      .delete(sessionMemory)
      .where(and(eq(sessionMemory.sessionId, sessionId), eq(sessionMemory.key, key)));
  },
};

/** Ephemeral store for admin test runs: never writes to a real session's memory. */
export function createInMemoryMemoryStore(): MemoryStore {
  const values = new Map<string, Record<string, unknown>>();
  const forSession = (sessionId: string) => values.get(sessionId) ?? {};
  return {
    async load(sessionId) {
      return { ...forSession(sessionId) };
    },
    async set(sessionId, key, value) {
      values.set(sessionId, { ...forSession(sessionId), [key]: value });
    },
    async append(sessionId, key, value) {
      const current = forSession(sessionId)[key];
      let next: unknown;
      if (Array.isArray(current)) next = [...current, value];
      else if (current === undefined || current === null) next = value;
      else if (typeof current === "string" && typeof value === "string")
        next = `${current}\n${value}`;
      else next = value;
      await this.set(sessionId, key, next);
      return next;
    },
    async remove(sessionId, key) {
      const copy = { ...forSession(sessionId) };
      delete copy[key];
      values.set(sessionId, copy);
    },
  };
}
