import path from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createSql } from "@/server/db/client";

/** Applies pending migrations from `./drizzle` (relative to the working directory). */
export async function runMigrations(
  databaseUrl: string,
  migrationsFolder = path.join(process.cwd(), "drizzle"),
): Promise<void> {
  const sql = createSql(databaseUrl, { max: 1, onnotice: () => {} });
  try {
    await migrate(drizzle(sql), { migrationsFolder });
  } finally {
    await sql.end({ timeout: 5 });
  }
}
