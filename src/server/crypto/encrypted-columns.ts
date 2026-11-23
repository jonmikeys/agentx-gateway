/**
 * Central registry of every database column that stores a value encrypted with
 * `encryptSecret()`. `pnpm secrets:rotate` re-encrypts exactly these columns.
 *
 * Every encrypted column (provider keys and headers, camera credentials, MCP headers, webhook
 * header values) is listed below. A new encrypted column MUST add an entry here in the same
 * change that introduces it, otherwise key rotation silently skips it.
 */
export interface EncryptedColumn {
  /** Table name (snake_case SQL identifier). */
  table: string;
  /** Column holding the `v1:...` encrypted blob (text). */
  column: string;
  /** Primary key column(s) used to address each row during rotation. */
  primaryKey: string[];
}

export const encryptedColumns: EncryptedColumn[] = [
  { table: "providers", column: "api_key", primaryKey: ["id"] },
  { table: "providers", column: "extra_headers", primaryKey: ["id"] },
  { table: "cameras", column: "credentials", primaryKey: ["id"] },
  { table: "mcp_servers", column: "headers", primaryKey: ["id"] },
  { table: "flow_webhook_secrets", column: "value", primaryKey: ["flow_id", "node_id", "name"] },
];
