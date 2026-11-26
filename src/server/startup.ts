import { registerAgentPurgeHooks } from "@/server/agents/purge";
import { runMigrations } from "@/server/db/migrate";
import { EnvValidationError, getEnv, getPlainHttpWarning } from "@/server/env";
import { logger } from "@/server/logger";
import { startMaintenanceScheduler } from "@/server/services/session-maintenance";
import { isYtDlpAvailable } from "@/server/tools/builtin/video-resolver";

/** Server start-up: validate env, warn about insecure transport, apply migrations. */
export async function startup(): Promise<void> {
  try {
    const env = getEnv();
    const warning = getPlainHttpWarning(env);
    if (warning) logger.warn(warning);
    await runMigrations(env.DATABASE_URL);
    logger.info("Database migrations applied");
    registerAgentPurgeHooks();
    startMaintenanceScheduler();
    if (env.SEARXNG_URL) {
      // Probe once so the first chat does not wait for it; video_search needs yt-dlp.
      logger.info("Web search enabled", { video_playback: isYtDlpAvailable() });
    }
  } catch (error) {
    if (error instanceof EnvValidationError) {
      logger.error(error.message, { missing: error.missing, invalid: error.invalid });
    } else {
      logger.error("Startup failed", {
        error: error instanceof Error ? error.message : "unknown error",
      });
    }
    process.exit(1);
  }
}
