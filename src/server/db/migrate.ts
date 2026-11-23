import path from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createSql } from "@/server/db/client";

/** Advisory lock key shared by every process applying migrations to the same database. */
export const MIGRATION_LOCK_ID = 7420001;

/** Applies pending migrations from `./drizzle` (relative to the working directory). */
export async function runMigrations(
  databaseUrl: string,
  migrationsFolder = path.join(process.cwd(), "drizzle"),
): Promise<void> {
  const sql = createSql(databaseUrl, { max: 1, onnotice: () => {} });
  try {
    // Session-level lock: a concurrent process waits here, then reads the updated journal
    // and applies nothing. Closing the connection below releases it.
    await sql`select pg_advisory_lock(${MIGRATION_LOCK_ID})`;
    await migrate(drizzle(sql), { migrationsFolder });
  } finally {
    await sql.end({ timeout: 5 });
  }
}
