type Level = "debug" | "info" | "warn" | "error";

const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function currentLevel(): Level {
  const raw = process.env.LOG_LEVEL;
  return raw && raw in order ? (raw as Level) : "info";
}

function write(level: Level, message: string, fields?: Record<string, unknown>): void {
  if (order[level] < order[currentLevel()]) return;
  const line = JSON.stringify({ time: new Date().toISOString(), level, msg: message, ...fields });
  if (level === "error" || level === "warn") console.error(line);
  else console.log(line);
}

/**
 * Structured logger. Never pass transcript text or secrets as fields: log IDs,
 * timings and error codes only.
 */
export const logger = {
  debug: (message: string, fields?: Record<string, unknown>) => write("debug", message, fields),
  info: (message: string, fields?: Record<string, unknown>) => write("info", message, fields),
  warn: (message: string, fields?: Record<string, unknown>) => write("warn", message, fields),
  error: (message: string, fields?: Record<string, unknown>) => write("error", message, fields),
};
