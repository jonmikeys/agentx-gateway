import type { BuiltinToolName } from "@/lib/builtin-tools";
import { callMcpTool } from "@/server/gateway/mcp-client";
import type { ResolvedMcpTool } from "@/server/services/mcp";
import { getBuiltinTool, runBuiltinTool } from "@/server/tools/builtin/registry";
import type { BuiltinToolContext } from "@/server/tools/builtin/types";

/** Where a gateway-executed tool comes from; stored as `transcript_items.tool_source`. */
export type GatewayToolSource = "mcp" | "builtin";

/**
 * A tool the gateway offers to the model and executes itself in the plain-chat tool loop
 * (docs/mcp.md, docs/web-search.md): an allowed MCP tool or a built-in tool. Never exposed to
 * the client.
 */
export interface GatewayTool {
  exposedName: string;
  description: string;
  /** JSON Schema of the arguments. */
  inputSchema: unknown;
  source: GatewayToolSource;
  /** Runs the call. May throw; the loop feeds the error text back to the model. */
  call: (args: unknown) => Promise<{ text: string; isError: boolean }>;
}

export function mcpGatewayTool(tool: ResolvedMcpTool): GatewayTool {
  return {
    exposedName: tool.exposedName,
    description: tool.description,
    inputSchema: tool.inputSchema,
    source: "mcp",
    call: (args) => callMcpTool(tool.server, tool.toolName, args),
  };
}

export function builtinGatewayTool(
  name: BuiltinToolName,
  context: BuiltinToolContext,
): GatewayTool {
  const tool = getBuiltinTool(name);
  return {
    exposedName: tool.name,
    description: tool.description,
    inputSchema: tool.parameters,
    source: "builtin",
    call: (args) => runBuiltinTool(name, args, context),
  };
}

/** The route's MCP tools followed by its built-in tools, without duplicate names. */
export function routeGatewayTools(
  route: { mcpTools: ResolvedMcpTool[]; builtinTools: BuiltinToolName[] },
  context?: BuiltinToolContext,
): GatewayTool[] {
  const tools = [
    ...route.mcpTools.map(mcpGatewayTool),
    ...(context ? route.builtinTools.map((name) => builtinGatewayTool(name, context)) : []),
  ];
  const seen = new Set<string>();
  return tools.filter((tool) => {
    if (seen.has(tool.exposedName)) return false;
    seen.add(tool.exposedName);
    return true;
  });
}

/** Whether a route runs the gateway tool loop (and so always calls Chat Completions). */
export function routeHasGatewayTools(route: {
  mcpTools: unknown[];
  builtinTools: unknown[];
}): boolean {
  return route.mcpTools.length > 0 || route.builtinTools.length > 0;
}
