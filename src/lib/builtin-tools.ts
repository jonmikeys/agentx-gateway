import { z } from "zod";

/**
 * Built-in gateway tools (docs/web-search.md). Each model route can offer them next to its MCP
 * tools; the gateway executes them in the plain-chat tool loop and never exposes them to the
 * client. Shared by the CRM (labels) and the server (validation, registry).
 */
export const BUILTIN_TOOL_NAMES = ["web_search"] as const;

export type BuiltinToolName = (typeof BUILTIN_TOOL_NAMES)[number];

export const builtinToolNameSchema = z.enum(BUILTIN_TOOL_NAMES);

export interface BuiltinToolInfo {
  name: BuiltinToolName;
  label: string;
  /** One line for admins in the route editor. */
  summary: string;
}

export const BUILTIN_TOOL_INFO: Record<BuiltinToolName, BuiltinToolInfo> = {
  web_search: {
    name: "web_search",
    label: "Web search",
    summary: "Searches the web with SearXNG and returns titles, links and snippets.",
  },
};

/** Admin view: a built-in tool and whether this deployment can run it. */
export interface BuiltinToolView extends BuiltinToolInfo {
  available: boolean;
  /** Why the tool cannot run (for example a missing environment variable); absent when it can. */
  unavailable_reason?: string;
}
