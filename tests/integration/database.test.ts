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

  it("round-trips a settings row through Drizzle", async () => {
    const db = drizzle(sql);
    await db.insert(settings).values({ key: "idle_timeout_minutes", value: { minutes: 30 } });
    const [row] = await db.select().from(settings).where(eq(settings.key, "idle_timeout_minutes"));
    expect(row.value).toEqual({ minutes: 30 });
    expect(row.updatedAt).toBeInstanceOf(Date);
  });

  it("starts with an empty encrypted column registry", () => {
    expect(encryptedColumns).toEqual([]);
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
