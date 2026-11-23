/**
 * Naming rules for tools exposed to models. OpenAI-compatible function names are limited to
 * 64 characters of `[a-zA-Z0-9_.-]`, so an MCP tool is exposed as `<server_slug>__<tool_name>`
 * after sanitising both segments. Tools whose exposed name is still invalid are not offered.
 */
export const MAX_TOOL_NAME_LENGTH = 64;
export const TOOL_NAME_SEPARATOR = "__";

const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_.-]+$/;

/** Replaces characters that OpenAI function names do not allow. */
export function sanitizeToolSegment(value: string): string {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9_.-]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function validateToolName(name: string): { ok: true } | { ok: false; reason: string } {
  if (name.length === 0) return { ok: false, reason: "is empty" };
  if (name.length > MAX_TOOL_NAME_LENGTH) {
    return { ok: false, reason: `is longer than ${MAX_TOOL_NAME_LENGTH} characters` };
  }
  if (!TOOL_NAME_PATTERN.test(name)) {
    return { ok: false, reason: "contains characters OpenAI does not allow" };
  }
  return { ok: true };
}

/** The name offered to the model for one MCP tool on a server. */
export function exposedToolName(serverSlug: string, toolName: string): string {
  return `${sanitizeToolSegment(serverSlug)}${TOOL_NAME_SEPARATOR}${sanitizeToolSegment(toolName)}`;
}

export type ExposedNameResult =
  | { ok: true; name: string }
  | { ok: false; name: string; reason: string };

/** Exposes a tool name and validates it against the OpenAI function-name rules. */
export function validateExposedToolName(serverSlug: string, toolName: string): ExposedNameResult {
  const name = exposedToolName(serverSlug, toolName);
  const check = validateToolName(name);
  if (check.ok) return { ok: true, name };
  return { ok: false, name, reason: `${name} ${check.reason}` };
}
