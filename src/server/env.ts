import { z } from "zod";

/** Decodes a base64 master key and checks it is exactly 32 bytes. */
export function isValidEncryptionKey(value: string): boolean {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  return Buffer.from(value, "base64").length === 32;
}

/** Treats empty strings (as found in a freshly copied `.env.example`) as unset. */
const optionalText = z
  .string()
  .optional()
  .transform((value) => (value === undefined || value.trim() === "" ? undefined : value.trim()));

const requiredText = z.string().trim().min(1);

const logLevels = ["debug", "info", "warn", "error"] as const;

export const envSchema = z.object({
  DATABASE_URL: requiredText.refine(
    (value) => /^postgres(ql)?:\/\//.test(value),
    "must be a postgres:// or postgresql:// connection string",
  ),
  GATEWAY_ENCRYPTION_KEY: requiredText.refine(
    isValidEncryptionKey,
    "must be base64 and decode to exactly 32 bytes (run `pnpm secrets:genkey`)",
  ),
  NEW_GATEWAY_ENCRYPTION_KEY: optionalText.refine(
    (value) => value === undefined || isValidEncryptionKey(value),
    "must be base64 and decode to exactly 32 bytes (run `pnpm secrets:genkey`)",
  ),
  ADMIN_USERNAME: requiredText,
  ADMIN_PASSWORD: requiredText,
  PUBLIC_BASE_URL: optionalText.refine(
    (value) => value === undefined || URL.canParse(value),
    "must be an absolute URL such as https://gateway.example.com",
  ),
  MEDIA_STORAGE_DIR: optionalText.transform((value) => value ?? "/data/media"),
  LOG_LEVEL: optionalText.transform((value) => value ?? "info").pipe(z.enum(logLevels)),
  GATEWAY_DOMAIN: optionalText,
});

export type Env = z.infer<typeof envSchema>;

/** Thrown when the environment is invalid. The message lists variable NAMES only. */
export class EnvValidationError extends Error {
  readonly missing: string[];
  readonly invalid: string[];

  constructor(missing: string[], invalid: string[]) {
    const parts: string[] = [];
    if (missing.length > 0) parts.push(`missing: ${missing.join(", ")}`);
    if (invalid.length > 0) parts.push(`invalid: ${invalid.join(", ")}`);
    super(`Invalid environment configuration (${parts.join("; ")})`);
    this.name = "EnvValidationError";
    this.missing = missing;
    this.invalid = invalid;
  }
}

/**
 * Validates an environment object. Error details deliberately carry variable
 * names only, never the offending values (they may be secrets).
 */
export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(source);
  if (result.success) return result.data;

  const missing = new Set<string>();
  const invalid = new Set<string>();
  for (const issue of result.error.issues) {
    const name = String(issue.path[0] ?? "");
    if (!name) continue;
    const value = source[name];
    if (value === undefined || value.trim() === "") missing.add(name);
    else invalid.add(name);
  }
  throw new EnvValidationError([...missing], [...invalid]);
}

let cachedEnv: Env | undefined;

/** Lazily validated process environment. Never call at module top level (it would break `next build`). */
export function getEnv(): Env {
  cachedEnv ??= parseEnv(process.env);
  return cachedEnv;
}

export function resetEnvCacheForTests(): void {
  cachedEnv = undefined;
}

const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** Returns a warning when admin Basic auth would travel over plain HTTP on a non-loopback host. */
export function getPlainHttpWarning(env: Pick<Env, "PUBLIC_BASE_URL">): string | undefined {
  if (!env.PUBLIC_BASE_URL) return undefined;
  const url = new URL(env.PUBLIC_BASE_URL);
  if (url.protocol !== "http:") return undefined;
  if (loopbackHosts.has(url.hostname)) return undefined;
  return `PUBLIC_BASE_URL uses plain http:// on non-loopback host "${url.hostname}": basic auth is exposed over plain HTTP. Terminate TLS in front of the gateway (see docs/deployment.md).`;
}
