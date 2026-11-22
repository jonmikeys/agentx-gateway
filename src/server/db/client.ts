import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/server/db/schema";
import { getEnv } from "@/server/env";

export type Database = PostgresJsDatabase<typeof schema>;

interface Connection {
  sql: postgres.Sql;
  db: Database;
}

let connection: Connection | undefined;

export function createSql(
  databaseUrl: string,
  options: postgres.Options<Record<string, postgres.PostgresType>> = {},
): postgres.Sql {
  return postgres(databaseUrl, { connect_timeout: 5, ...options });
}

function getConnection(): Connection {
  if (!connection) {
    const sql = createSql(getEnv().DATABASE_URL);
    connection = { sql, db: drizzle(sql, { schema }) };
  }
  return connection;
}

/** Lazily created Drizzle client (nothing connects at import time). */
export function getDb(): Database {
  return getConnection().db;
}

/** Runs `select 1`; resolves true when the database answers. */
export async function pingDatabase(): Promise<boolean> {
  try {
    await getConnection().sql`select 1`;
    return true;
  } catch {
    return false;
  }
}

/** Closes the shared connection pool (tests, scripts). */
export async function closeDatabase(): Promise<void> {
  const current = connection;
  connection = undefined;
  await current?.sql.end({ timeout: 2 });
}
