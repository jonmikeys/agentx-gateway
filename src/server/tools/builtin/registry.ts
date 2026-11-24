import {
  BUILTIN_TOOL_INFO,
  BUILTIN_TOOL_NAMES,
  type BuiltinToolName,
  type BuiltinToolView,
} from "@/lib/builtin-tools";
import { getEnv } from "@/server/env";
import { readWebPageTool } from "@/server/tools/builtin/read-web-page";
import type {
  BuiltinTool,
  BuiltinToolContext,
  BuiltinToolResult,
  SearchSettings,
} from "@/server/tools/builtin/types";
import { webSearchTool } from "@/server/tools/builtin/web-search";

const TOOLS: Record<BuiltinToolName, BuiltinTool> = {
  web_search: webSearchTool as unknown as BuiltinTool,
  read_web_page: readWebPageTool as unknown as BuiltinTool,
};

export function getBuiltinTool(name: BuiltinToolName): BuiltinTool {
  return TOOLS[name];
}

/** Search settings from the environment; undefined when web search is not configured. */
export function searchSettingsFromEnv(): SearchSettings | undefined {
  const env = getEnv();
  if (!env.SEARXNG_URL) return undefined;
  return { url: env.SEARXNG_URL, safesearch: env.SEARCH_SAFESEARCH as 0 | 1 | 2 };
}

/**
 * Every built-in tool with its availability on this deployment (for the CRM). `search` defaults
 * to the environment; pass `null` for "not configured".
 */
export function listBuiltinTools(
  search: SearchSettings | null = searchSettingsFromEnv() ?? null,
): BuiltinToolView[] {
  return BUILTIN_TOOL_NAMES.map((name) => {
    const availability = TOOLS[name].availability({ search: search ?? undefined });
    return {
      ...BUILTIN_TOOL_INFO[name],
      available: availability === true,
      ...(availability === true ? {} : { unavailable_reason: availability }),
    };
  });
}

/** The selected names this deployment can run, in catalogue order (`search` as above). */
export function availableBuiltinTools(
  selected: readonly string[],
  search: SearchSettings | null = searchSettingsFromEnv() ?? null,
): BuiltinToolName[] {
  const wanted = new Set(selected);
  return BUILTIN_TOOL_NAMES.filter(
    (name) =>
      wanted.has(name) && TOOLS[name].availability({ search: search ?? undefined }) === true,
  );
}

/** Validates the arguments and runs a tool. Never throws: errors become an error result. */
export async function runBuiltinTool(
  name: BuiltinToolName,
  rawArgs: unknown,
  context: BuiltinToolContext,
): Promise<BuiltinToolResult> {
  const tool = getBuiltinTool(name);
  const availability = tool.availability(context);
  if (availability !== true) return { text: `Error: ${availability}`, isError: true };
  const parsed = tool.args.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "arguments"}: ${issue.message}`)
      .join("; ");
    return { text: `Error: invalid arguments (${detail})`, isError: true };
  }
  try {
    return await tool.execute(parsed.data, context);
  } catch (error) {
    const message = error instanceof Error ? error.message : "the tool failed";
    return { text: `Error: ${message}`, isError: true };
  }
}
