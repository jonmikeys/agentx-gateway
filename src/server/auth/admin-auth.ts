import { createHash, timingSafeEqual } from "node:crypto";
import { FailedLoginLimiter } from "@/server/auth/rate-limit";
import { getEnv } from "@/server/env";

export const ADMIN_REALM = "AGENTX Gateway";

export type AuthResult = { ok: true; username: string } | { ok: false };

/**
 * Seam for admin authentication. `BasicAdminAuth` is the G1 implementation;
 * a session based implementation (e.g. Better Auth) can replace it without
 * touching the proxy or the admin API.
 */
export interface AdminAuth {
  authenticate(request: Request): AuthResult | Promise<AuthResult>;
}

export interface BasicCredentials {
  username: string;
  password: string;
}

/** Parses an `Authorization: Basic ...` header. Returns undefined when absent or malformed. */
export function parseBasicAuthHeader(
  header: string | null | undefined,
): BasicCredentials | undefined {
  if (!header) return undefined;
  const match = /^Basic\s+([A-Za-z0-9+/]+={0,2})\s*$/i.exec(header);
  if (!match) return undefined;
  const decoded = Buffer.from(match[1], "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator === -1) return undefined;
  return { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
}

/** Constant-time string comparison (hashes first so lengths never leak). */
export function safeEqual(a: string, b: string): boolean {
  const hashA = createHash("sha256").update(a).digest();
  const hashB = createHash("sha256").update(b).digest();
  return timingSafeEqual(hashA, hashB);
}

export class BasicAdminAuth implements AdminAuth {
  constructor(private readonly expected: BasicCredentials) {}

  authenticate(request: Request): AuthResult {
    const provided = parseBasicAuthHeader(request.headers.get("authorization"));
    if (!provided) return { ok: false };
    // Evaluate both comparisons so timing does not reveal which one failed.
    const usernameMatches = safeEqual(provided.username, this.expected.username);
    const passwordMatches = safeEqual(provided.password, this.expected.password);
    return usernameMatches && passwordMatches
      ? { ok: true, username: this.expected.username }
      : { ok: false };
  }
}

/**
 * Best-effort client identity for the failed-login limiter.
 *
 * The nearest reverse proxy (Caddy) appends — or replaces — the real client address in
 * `X-Forwarded-For`. Earlier entries are client-supplied, so take the rightmost value.
 * The app port must not be exposed to untrusted networks: a direct client fully controls
 * this header, so it can otherwise choose its own rate-limit bucket.
 */
export function getClientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const addresses = forwarded
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    if (addresses.length > 0) return addresses[addresses.length - 1];
  }
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}

export function unauthorizedResponse(): Response {
  return new Response("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": `Basic realm="${ADMIN_REALM}", charset="UTF-8"` },
  });
}

export function tooManyAttemptsResponse(retryAfterSeconds: number): Response {
  return new Response("Too many failed login attempts. Try again later.", {
    status: 429,
    headers: { "Retry-After": String(retryAfterSeconds) },
  });
}

export const adminLoginLimiter = new FailedLoginLimiter();

let activeAuth: AdminAuth | undefined;

/** The configured AdminAuth implementation (swap here to change the auth mechanism). */
export function getAdminAuth(): AdminAuth {
  if (!activeAuth) {
    const env = getEnv();
    activeAuth = new BasicAdminAuth({ username: env.ADMIN_USERNAME, password: env.ADMIN_PASSWORD });
  }
  return activeAuth;
}

export function resetAdminAuthForTests(): void {
  activeAuth = undefined;
}

/**
 * Authenticates a request with rate limiting. Returns either the authenticated
 * username or a ready-to-send failure response (401 or 429).
 */
export async function guardAdminRequest(
  request: Request,
  auth: AdminAuth = getAdminAuth(),
  limiter: FailedLoginLimiter = adminLoginLimiter,
): Promise<{ username: string } | { response: Response }> {
  const ip = getClientIp(request);
  const blockedFor = limiter.blockedForSeconds(ip);
  if (blockedFor > 0) return { response: tooManyAttemptsResponse(blockedFor) };

  const result = await auth.authenticate(request);
  if (result.ok) return { username: result.username };

  // Requests with no credentials at all are just the browser's first probe; only
  // actual wrong credentials count as failed logins.
  if (request.headers.has("authorization")) limiter.recordFailure(ip);
  return { response: unauthorizedResponse() };
}
