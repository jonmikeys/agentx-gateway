import { createMiddleware } from "hono/factory";
import { openAIError } from "@/server/api/errors";
import { hashApiKey } from "@/server/gateway/api-key-format";
import { isIpAllowed, parseIp } from "@/server/gateway/cidr";
import { cacheApiKey, getCachedApiKey } from "@/server/gateway/client-auth-cache";
import {
  dayWindowStart,
  incrementCounter,
  minuteWindowStart,
  readCounter,
  secondsUntilNextDay,
  secondsUntilNextMinute,
} from "@/server/gateway/rate-counters";
import { logger } from "@/server/logger";
import { type ApiKeyRecord, findApiKeyByHash, touchApiKey } from "@/server/services/api-keys";

export type ClientEnv = { Variables: { apiKey: ApiKeyRecord } };

const LAST_USED_INTERVAL_MS = 60_000;
const lastTouched = new Map<string, number>();

/**
 * Client IP for allowlist checks. Next route handlers do not expose the socket address, so
 * this trusts `X-Forwarded-For` (first entry) or `X-Real-IP`, which a reverse proxy must set.
 */
export function getForwardedIp(headers: Headers): string | undefined {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const candidate = forwarded || headers.get("x-real-ip")?.trim();
  if (!candidate) return undefined;
  return parseIp(candidate) ? candidate : undefined;
}

export function parseBearerToken(header: string | null | undefined): string | undefined {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header ?? "");
  return match?.[1];
}

function invalidKey(): Response {
  return openAIError(
    401,
    "invalid_api_key",
    "Invalid or missing API key. Send 'Authorization: Bearer <key>'.",
    "authentication_error",
  );
}

async function lookup(hash: string): Promise<ApiKeyRecord | undefined> {
  const cached = getCachedApiKey(hash);
  if (cached) return cached.record;
  const record = await findApiKeyByHash(hash);
  cacheApiKey(hash, record);
  return record;
}

function touchThrottled(id: string): void {
  const now = Date.now();
  if (now - (lastTouched.get(id) ?? 0) < LAST_USED_INTERVAL_MS) return;
  lastTouched.set(id, now);
  touchApiKey(id).catch((error: unknown) =>
    logger.warn("Failed to update last_used_at", { error: String(error) }),
  );
}

/** Returns a 429 response when the key exceeds its requests-per-minute or tokens-per-day limit. */
async function checkLimits(record: ApiKeyRecord): Promise<Response | undefined> {
  const now = new Date();
  if (record.rpmLimit !== null) {
    const count = await incrementCounter(record.id, "minute", minuteWindowStart(now));
    if (count > record.rpmLimit) {
      return openAIError(
        429,
        "rate_limit_exceeded",
        `Rate limit of ${record.rpmLimit} requests per minute exceeded.`,
        "rate_limit_error",
        { "Retry-After": String(secondsUntilNextMinute(now)) },
      );
    }
  }
  if (record.tokensPerDayLimit !== null) {
    const used = await readCounter(record.id, "day", dayWindowStart(now));
    if (used >= record.tokensPerDayLimit) {
      return openAIError(
        429,
        "rate_limit_exceeded",
        `Daily token limit of ${record.tokensPerDayLimit} reached.`,
        "rate_limit_error",
        { "Retry-After": String(secondsUntilNextDay(now)) },
      );
    }
  }
  return undefined;
}

/** Records consumed tokens against the key's daily window (after a request completes). */
export async function recordTokenUsage(record: ApiKeyRecord, totalTokens: number): Promise<void> {
  if (record.tokensPerDayLimit === null || totalTokens <= 0) return;
  await incrementCounter(record.id, "day", dayWindowStart(new Date()), totalTokens);
}

/** Bearer API key auth for the client API: key lookup, IP allowlist, then rate limits. */
export const clientAuth = createMiddleware<ClientEnv>(async (c, next) => {
  const token = parseBearerToken(c.req.header("authorization"));
  if (!token) return invalidKey();

  const record = await lookup(hashApiKey(token));
  if (!record || record.revokedAt) return invalidKey();

  if (record.ipAllowlist.length > 0) {
    const ip = getForwardedIp(c.req.raw.headers);
    if (!isIpAllowed(record.ipAllowlist, ip)) {
      return openAIError(
        403,
        "ip_not_allowed",
        "This API key may not be used from your IP address.",
        "permission_error",
      );
    }
  }

  const limited = await checkLimits(record);
  if (limited) return limited;

  touchThrottled(record.id);
  c.set("apiKey", record);
  await next();
});
