import type { Context } from "hono";
import type { ZodType } from "zod";
import { ServiceError } from "@/server/services/errors";

export function adminError(
  c: Context,
  status: 400 | 404 | 409 | 413 | 415 | 502,
  code: string,
  message: string,
  details?: unknown,
) {
  return c.json({ error: { code, message, ...(details ? { details } : {}) } }, status);
}

/** Parses and validates a JSON body; returns a ready 400 response on failure. */
export async function parseBody<T>(
  c: Context,
  schema: ZodType<T>,
): Promise<{ data: T } | { response: Response }> {
  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    return { response: adminError(c, 400, "invalid_json", "Request body must be valid JSON") };
  }
  const result = schema.safeParse(json);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    }));
    return {
      response: adminError(
        c,
        400,
        "validation_error",
        issues[0] ? `${issues[0].path || "body"}: ${issues[0].message}` : "Invalid body",
        issues,
      ),
    };
  }
  return { data: result.data };
}

/** Maps a thrown `ServiceError` to a JSON response; rethrows anything else. */
export function handleServiceError(c: Context, error: unknown): Response {
  if (error instanceof ServiceError) {
    return adminError(c, error.status, error.code, error.message, error.details);
  }
  throw error;
}
