import type postgres from "postgres";
import type { EncryptedColumn } from "@/server/crypto/encrypted-columns";
import { decryptSecretWithKey, encryptSecretWithKey } from "@/server/crypto/secrets";

const identifier = /^[a-z_][a-z0-9_]*$/;

function assertIdentifier(value: string): void {
  if (!identifier.test(value)) throw new Error(`Invalid SQL identifier in registry: ${value}`);
}

/**
 * Re-encrypts every registered column from `oldKey` to `newKey` inside ONE transaction:
 * either every secret is rotated or none is. Returns the number of rotated values.
 */
export async function rotateSecrets(
  sql: postgres.Sql,
  oldKey: string,
  newKey: string,
  columns: EncryptedColumn[],
): Promise<number> {
  for (const spec of columns) {
    assertIdentifier(spec.table);
    assertIdentifier(spec.column);
    for (const key of spec.primaryKey) assertIdentifier(key);
  }

  let rotated = 0;
  await sql.begin(async (tx) => {
    for (const spec of columns) {
      const selected = await tx`
        select ${tx(spec.primaryKey)}, ${tx(spec.column)} as secret
        from ${tx(spec.table)}
        where ${tx(spec.column)} is not null
        for update`;
      for (const row of selected) {
        const reEncrypted = encryptSecretWithKey(
          decryptSecretWithKey(String(row.secret), oldKey),
          newKey,
        );
        const conditions = spec.primaryKey.map((key) => tx`${tx(key)} = ${row[key]}`);
        const where = conditions.reduce((acc, condition) => tx`${acc} and ${condition}`);
        await tx`update ${tx(spec.table)} set ${tx(spec.column)} = ${reEncrypted} where ${where}`;
        rotated += 1;
      }
    }
  });
  return rotated;
}
