import { renderTemplate, type TemplateScope } from "@/lib/agents/templates";

/**
 * Client (Unity) tools forwarded by the request (spec §13). These helpers are shared by the
 * runtime (narrowing the offered tool enums, building Client Action calls) and the CRM editor
 * (validating a Client Action against the agent's media/camera restrictions).
 */

export type ClientToolMode = "none" | "all" | "subset";

export interface ClientToolSelection {
  mode: ClientToolMode;
  /** Tool names offered when `mode` is `subset`. */
  names: string[];
}

export const NO_CLIENT_TOOLS: ClientToolSelection = { mode: "none", names: [] };

/** A chat-completions function tool as sent by the client. */
export interface ClientToolDefinition {
  type: "function";
  function: {
    name: string;
    description?: unknown;
    parameters?: unknown;
    strict?: unknown;
  };
}

/** One client tool call the gateway hands back to the client. */
export interface ClientToolCall {
  id: string;
  name: string;
  /** Raw JSON arguments text. */
  arguments: string;
}

/** One tool result the client sends back to resume a paused run. */
export interface ClientToolResult {
  toolCallId: string;
  content: string;
}

/** Effective media/camera allow-lists; `null` means "not restricted". */
export interface ClientToolRestrictions {
  mediaIds: string[] | null;
  cameraIds: string[] | null;
}

export const UNRESTRICTED: ClientToolRestrictions = { mediaIds: null, cameraIds: null };

/** Catalogue tools whose arguments reference a media item or a camera. */
export const MEDIA_TOOL_NAMES = new Set(["show_image", "show_video"]);
export const CAMERA_TOOL_NAMES = new Set(["show_camera"]);
export const ANIMATION_TOOL_NAMES = new Set(["play_animation"]);

/** Tools the Client Action node offers as fixed pickers (anything else is free-form). */
export const CLIENT_ACTION_TOOLS = [
  { name: "show_image", label: "Show image", argument: "media_id" },
  { name: "show_video", label: "Show video", argument: "media_id" },
  { name: "show_camera", label: "Show camera", argument: "camera_id" },
  { name: "play_animation", label: "Play animation", argument: "animation_id" },
] as const;

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function isClientToolDefinition(value: unknown): value is ClientToolDefinition {
  const tool = asObject(value);
  const fn = asObject(tool?.function);
  return tool?.type === "function" && typeof fn?.name === "string" && fn.name.length > 0;
}

/** Normalises the request's `tools` array, keeping only function tools with a name. */
export function normalizeClientTools(raw: unknown): ClientToolDefinition[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isClientToolDefinition);
}

/** The tools one LLM node offers: none, every request tool, or the named subset. */
export function selectClientTools(
  tools: ClientToolDefinition[],
  selection: ClientToolSelection,
): ClientToolDefinition[] {
  if (selection.mode === "none") return [];
  if (selection.mode === "all") return tools;
  const names = new Set(selection.names);
  return tools.filter((tool) => names.has(tool.function.name));
}

function narrowEnum(tool: ClientToolDefinition, property: string, ids: string[]): void {
  const parameters = asObject(tool.function.parameters);
  if (!parameters) return;
  const properties = asObject(parameters.properties);
  const target = asObject(properties?.[property]);
  if (!target) return;
  target.enum = [...ids];
}

/**
 * Narrows the `media_id` / `camera_id` enums of forwarded catalogue tools to the agent's allowed
 * sets. A `null` set leaves that enum exactly as the client sent it.
 */
export function restrictClientTools(
  tools: ClientToolDefinition[],
  restrictions: ClientToolRestrictions,
): ClientToolDefinition[] {
  if (restrictions.mediaIds === null && restrictions.cameraIds === null) return tools;
  return tools.map((tool) => {
    const copy = structuredClone(tool);
    const name = copy.function.name;
    if (
      restrictions.mediaIds !== null &&
      (MEDIA_TOOL_NAMES.has(name) || hasProperty(copy, "media_id"))
    ) {
      narrowEnum(copy, "media_id", restrictions.mediaIds);
    }
    if (
      restrictions.cameraIds !== null &&
      (CAMERA_TOOL_NAMES.has(name) || hasProperty(copy, "camera_id"))
    ) {
      narrowEnum(copy, "camera_id", restrictions.cameraIds);
    }
    return copy;
  });
}

function hasProperty(tool: ClientToolDefinition, property: string): boolean {
  const properties = asObject(asObject(tool.function.parameters)?.properties);
  return properties !== undefined && property in properties;
}

export type ArgsTemplateResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string };

/**
 * Renders a Client Action's JSON args template and parses it. Templates are lookups only, so an
 * unresolvable path renders empty and the JSON parse then fails loudly.
 */
export function renderClientActionArgs(template: string, scope: TemplateScope): ArgsTemplateResult {
  const rendered = renderTemplate(template, scope).trim();
  if (rendered === "") return { ok: true, value: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(rendered);
  } catch {
    return { ok: false, error: "Client Action arguments must be valid JSON after templating." };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "Client Action arguments must be a JSON object." };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

/** Parses a client tool result body, preferring a JSON object (for `ok` / media ids). */
export function parseToolResultContent(content: string): unknown {
  const trimmed = content.trim();
  if (trimmed === "") return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return content;
  }
}

/** `ok: false` on a JSON result sends a Client Action down its error handle. */
export function toolResultFailed(content: string): boolean {
  const parsed = asObject(parseToolResultContent(content));
  return parsed?.ok === false;
}

/**
 * Checks a Client Action against the agent's allowed sets. Returns a human problem, or undefined.
 * A `null` set means the agent does not restrict that catalogue.
 */
export function clientActionProblem(
  toolName: string,
  args: Record<string, unknown>,
  restrictions: ClientToolRestrictions,
): string | undefined {
  if (restrictions.mediaIds !== null && (MEDIA_TOOL_NAMES.has(toolName) || "media_id" in args)) {
    const mediaId = args.media_id;
    if (typeof mediaId !== "string" || mediaId === "") {
      return "Choose a media item for this Client Action.";
    }
    if (!restrictions.mediaIds.includes(mediaId)) {
      return `Media "${mediaId}" is outside the agent's allowed media tags.`;
    }
  }
  if (restrictions.cameraIds !== null && (CAMERA_TOOL_NAMES.has(toolName) || "camera_id" in args)) {
    const cameraId = args.camera_id;
    if (typeof cameraId !== "string" || cameraId === "") {
      return "Choose a camera for this Client Action.";
    }
    if (!restrictions.cameraIds.includes(cameraId)) {
      return `Camera "${cameraId}" is not in the agent's allowed cameras.`;
    }
  }
  return undefined;
}
