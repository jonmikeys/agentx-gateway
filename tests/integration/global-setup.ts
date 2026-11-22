import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

let container: StartedPostgreSqlContainer | undefined;

/** Starts one throwaway Postgres for the whole integration run. Requires Docker. */
export default async function setup(project: TestProject) {
  container = await new PostgreSqlContainer("postgres:17-alpine").start();
  project.provide("databaseUrl", container.getConnectionUri());
  return async () => {
    await container?.stop();
  };
}
