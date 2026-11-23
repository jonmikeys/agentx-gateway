import { DEFAULT_SESSION_SETTINGS, type SessionSettings } from "@/lib/session-types";
import { getSetting, setSetting } from "@/server/services/settings";

const CACHE_TTL_MS = 5000;

let cached: { value: SessionSettings; expiresAt: number } | undefined;

/** Typed accessor over the `settings` table; falls back to the defaults for unset keys. */
export async function getSessionSettings(): Promise<SessionSettings> {
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const defaults = DEFAULT_SESSION_SETTINGS;
  const [idleTimeout, retention, redaction] = await Promise.all([
    getSetting("idle_timeout_minutes", defaults.idle_timeout_minutes),
    getSetting("retention_days", defaults.retention_days),
    getSetting("redaction_enabled", defaults.redaction_enabled),
  ]);
  const value: SessionSettings = {
    idle_timeout_minutes: Number(idleTimeout),
    retention_days: Number(retention),
    redaction_enabled: redaction === true,
  };
  cached = { value, expiresAt: Date.now() + CACHE_TTL_MS };
  return value;
}

export async function updateSessionSettings(next: SessionSettings): Promise<SessionSettings> {
  await Promise.all(Object.entries(next).map(([key, value]) => setSetting(key, value)));
  cached = undefined;
  return next;
}

export function resetSessionSettingsCacheForTests(): void {
  cached = undefined;
}
