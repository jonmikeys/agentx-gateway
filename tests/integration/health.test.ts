import { afterEach, beforeEach, describe, expect, inject, it } from "vitest";
import { createApiApp } from "@/server/api/app";
import { closeDatabase } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { resetEnvCacheForTests } from "@/server/env";
import packageJson from "../../package.json";

const databaseUrl = inject("databaseUrl");

function setEnv(url: string) {
  process.env.DATABASE_URL = url;
  process.env.GATEWAY_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  process.env.ADMIN_USERNAME = "admin";
  process.env.ADMIN_PASSWORD = "secret";
  resetEnvCacheForTests();
}

describe("GET /health", () => {
  beforeEach(async () => {
    await closeDatabase();
  });

  afterEach(async () => {
    await closeDatabase();
  });

  it("returns ok with db:true when Postgres answers", async () => {
    setEnv(databaseUrl);
    await runMigrations(databaseUrl);
    const response = await createApiApp().request("/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, db: true, version: packageJson.version });
  });

  it("returns 503 with db:false when Postgres is unreachable", async () => {
    setEnv("postgres://nobody:nothing@127.0.0.1:1/none");
    const response = await createApiApp().request("/health");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, db: false, version: packageJson.version });
  });
});
