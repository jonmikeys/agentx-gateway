import { encryptedColumns } from "@/server/crypto/encrypted-columns";
import { rotateSecrets } from "@/server/crypto/rotate";
import { parseEncryptionKey } from "@/server/crypto/secrets";
import { createSql } from "@/server/db/client";

/**
 * Re-encrypts every registered secret column under a new key.
 *   GATEWAY_ENCRYPTION_KEY      current (old) key
 *   NEW_GATEWAY_ENCRYPTION_KEY  replacement key (create with `pnpm secrets:genkey`)
 * After success, set GATEWAY_ENCRYPTION_KEY to the new key and restart the app.
 */
async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  const oldKey = process.env.GATEWAY_ENCRYPTION_KEY;
  const newKey = process.env.NEW_GATEWAY_ENCRYPTION_KEY;

  const missing = [
    ["DATABASE_URL", databaseUrl],
    ["GATEWAY_ENCRYPTION_KEY", oldKey],
    ["NEW_GATEWAY_ENCRYPTION_KEY", newKey],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length > 0 || !databaseUrl || !oldKey || !newKey) {
    console.error(`Missing environment variables: ${missing.join(", ")}`);
    process.exit(1);
  }

  try {
    parseEncryptionKey(oldKey);
    parseEncryptionKey(newKey);
  } catch {
    console.error(
      "GATEWAY_ENCRYPTION_KEY and NEW_GATEWAY_ENCRYPTION_KEY must be base64 32-byte keys.",
    );
    process.exit(1);
  }

  if (oldKey === newKey) {
    console.error("NEW_GATEWAY_ENCRYPTION_KEY must differ from GATEWAY_ENCRYPTION_KEY.");
    process.exit(1);
  }

  const sql = createSql(databaseUrl, { max: 1 });
  try {
    const rotated = await rotateSecrets(sql, oldKey, newKey, encryptedColumns);
    console.log(
      `Re-encrypted ${rotated} value(s) across ${encryptedColumns.length} registered column(s).`,
    );
    console.log("Now set GATEWAY_ENCRYPTION_KEY to the new key and restart the gateway.");
  } catch (error) {
    console.error(
      "Rotation failed; no changes were applied:",
      error instanceof Error ? error.message : "unknown error",
    );
    process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

void main();
