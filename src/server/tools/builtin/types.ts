import type { ZodType } from "zod";
import type { BuiltinToolName } from "@/lib/builtin-tools";

/** SearXNG settings from the environment (`SEARXNG_URL`, `SEARCH_SAFESEARCH`). */
export interface SearchSettings {
  url: string;
  safesearch: 0 | 1 | 2;
}

/** Deployment settings and request facts a built-in tool may need. */
export interface BuiltinToolContext {
  /** Undefined when `SEARXNG_URL` is not set: the search tools are then unavailable. */
  search?: SearchSettings;
  /** Session that owns anything the tool creates (temporary media items). */
  sessionId?: string;
  apiKeyId?: string;
  /** Public origin for absolute URLs handed to the client (`content_url`). */
  baseUrl: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export interface BuiltinToolResult {
  text: string;
  isError: boolean;
}

export interface BuiltinTool<Args = unknown> {
  name: BuiltinToolName;
  /** What the model reads to decide when to call the tool. */
  description: string;
  /** JSON Schema for the arguments, offered to the model. */
  parameters: Record<string, unknown>;
  /** Validates the model's arguments; failures go back to the model as the tool result. */
  args: ZodType<Args>;
  /** `true` when this deployment can run the tool, otherwise the reason it cannot. */
  availability: (context: Pick<BuiltinToolContext, "search">) => true | string;
  execute: (args: Args, context: BuiltinToolContext) => Promise<BuiltinToolResult>;
}

export const SEARCH_NOT_CONFIGURED = "web search is not configured (set SEARXNG_URL)";

/** Availability rule shared by every tool that needs SearXNG. */
export function needsSearch(context: Pick<BuiltinToolContext, "search">): true | string {
  return context.search ? true : SEARCH_NOT_CONFIGURED;
}
