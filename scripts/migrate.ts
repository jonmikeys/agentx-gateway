import { runMigrations } from "@/server/db/migrate";
import { EnvValidationError, getEnv } from "@/server/env";

async function main(): Promise<void> {
  try {
    await runMigrations(getEnv().DATABASE_URL);
    console.log("Migrations applied.");
  } catch (error) {
    if (error instanceof EnvValidationError) console.error(error.message);
    else
      console.error("Migration failed:", error instanceof Error ? error.message : "unknown error");
    process.exit(1);
  }
}

void main();
