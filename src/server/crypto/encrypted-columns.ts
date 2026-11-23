/**
 * Central registry of every database column that stores a value encrypted with
 * `encryptSecret()`. `pnpm secrets:rotate` re-encrypts exactly these columns.
 *
 * G1 has no encrypted columns. Later stages (provider API keys, MCP headers,
 * webhook headers, camera credentials) MUST add an entry here in the same
 * change that introduces the column, otherwise key rotation silently skips it.
 */
export interface EncryptedColumn {
  /** Table name (snake_case SQL identifier). */
  table: string;
  /** Column holding the `v1:...` encrypted blob (text). */
  column: string;
  /** Primary key column(s) used to address each row during rotation. */
  primaryKey: string[];
}

export const encryptedColumns: EncryptedColumn[] = [];
