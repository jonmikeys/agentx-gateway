import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { encryptedColumns } from "@/server/crypto/encrypted-columns";
import { rotateSecrets } from "@/server/crypto/rotate";
import {
  decryptSecretWithKey,
  encryptSecretWithKey,
  generateEncryptionKey,
} from "@/server/crypto/secrets";
import { createSql } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { settings } from "@/server/db/schema";

const databaseUrl = inject("databaseUrl");

describe("database migrations", () => {
  const sql = createSql(databaseUrl, { max: 2, onnotice: () => {} });

  beforeAll(async () => {
    await runMigrations(databaseUrl);
  });

  afterAll(async () => {
    await sql.end({ timeout: 2 });
  });

  it("creates the settings table", async () => {
    const columns = await sql<{ column_name: string }[]>`
      select column_name from information_schema.columns
      where table_name = 'settings' order by column_name`;
    expect(columns.map((row) => row.column_name)).toEqual(["key", "updated_at", "value"]);
  });

  it("is idempotent when run again", async () => {
    await expect(runMigrations(databaseUrl)).resolves.toBeUndefined();
  });

  it("serializes concurrent migrations on a fresh database", async () => {
    const name = `migrate_lock_${Date.now()}`;
    await sql.unsafe(`create database ${name}`);
    try {
      const target = new URL(databaseUrl);
      target.pathname = `/${name}`;
      await Promise.all([runMigrations(target.toString()), runMigrations(target.toString())]);

      const check = createSql(target.toString(), { max: 1, onnotice: () => {} });
      try {
        const [row] = await check<{ present: boolean }[]>`
          select exists (
            select 1 from information_schema.tables
            where table_schema = 'public' and table_name = 'settings'
          ) as present`;
        expect(row.present).toBe(true);
      } finally {
        await check.end({ timeout: 2 });
      }
    } finally {
      await sql.unsafe(`drop database if exists ${name} with (force)`);
    }
  });

  it("round-trips a settings row through Drizzle", async () => {
    const db = drizzle(sql);
    await db.insert(settings).values({ key: "idle_timeout_minutes", value: { minutes: 30 } });
    const [row] = await db.select().from(settings).where(eq(settings.key, "idle_timeout_minutes"));
    expect(row.value).toEqual({ minutes: 30 });
    expect(row.updatedAt).toBeInstanceOf(Date);
  });

  it("registers every encrypted provider column", () => {
    expect(encryptedColumns).toEqual(
      expect.arrayContaining([
        { table: "providers", column: "api_key", primaryKey: ["id"] },
        { table: "providers", column: "extra_headers", primaryKey: ["id"] },
      ]),
    );
  });

  it("rotates the real provider columns via the registry", async () => {
    const oldKey = generateEncryptionKey();
    const newKey = generateEncryptionKey();
    await sql`insert into providers (name, base_url, api_key, extra_headers) values
      ('RotateP1', 'http://a', ${encryptSecretWithKey("key-one", oldKey)}, ${encryptSecretWithKey('{"X":"1"}', oldKey)}),
      ('RotateP2', 'http://b', null, null)`;
    const rotated = await rotateSecrets(sql, oldKey, newKey, encryptedColumns);
    expect(rotated).toBe(2);
    const [row] = await sql<{ api_key: string; extra_headers: string }[]>`
      select api_key, extra_headers from providers where name = 'RotateP1'`;
    expect(decryptSecretWithKey(row.api_key, newKey)).toBe("key-one");
    expect(decryptSecretWithKey(row.extra_headers, newKey)).toBe('{"X":"1"}');
  });

  it("rotates registered secret columns atomically", async () => {
    const oldKey = generateEncryptionKey();
    const newKey = generateEncryptionKey();
    await sql`create table rotate_demo (id int primary key, secret text)`;
    await sql`insert into rotate_demo values
      (1, ${encryptSecretWithKey("alpha", oldKey)}),
      (2, ${encryptSecretWithKey("beta", oldKey)}),
      (3, null)`;
    const columns = [{ table: "rotate_demo", column: "secret", primaryKey: ["id"] }];

    const rotated = await rotateSecrets(sql, oldKey, newKey, columns);
    expect(rotated).toBe(2);
    const rows = await sql<
      { id: number; secret: string | null }[]
    >`select * from rotate_demo order by id`;
    expect(decryptSecretWithKey(rows[0].secret as string, newKey)).toBe("alpha");
    expect(decryptSecretWithKey(rows[1].secret as string, newKey)).toBe("beta");
    expect(rows[2].secret).toBeNull();

    // Wrong old key must roll everything back.
    await expect(rotateSecrets(sql, oldKey, generateEncryptionKey(), columns)).rejects.toThrow();
    const after = await sql<{ secret: string }[]>`select secret from rotate_demo where id = 1`;
    expect(decryptSecretWithKey(after[0].secret, newKey)).toBe("alpha");
  });
});
