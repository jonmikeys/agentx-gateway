import { databaseMemoryStore } from "@/server/agents/memory";
import type { AgentDependencies } from "@/server/agents/nodes";
import { callMcpTool } from "@/server/gateway/mcp-client";
import { loadSubflowVersion, webhookHeaderValues } from "@/server/services/agents";
import { resolveMcpToolForCall, resolveMcpToolsByIds } from "@/server/services/mcp";
import { resolveRoute } from "@/server/services/routes";

/** Production dependencies for the node executors (tests inject their own subset). */
export const defaultAgentDependencies: AgentDependencies = {
  resolveRoute: (slug) => resolveRoute({ kind: "slug", slug }),
  mcpToolsByIds: resolveMcpToolsByIds,
  mcpCall: async (serverId, toolName, args) => {
    const tool = await resolveMcpToolForCall(serverId, toolName);
    if (!tool) {
      throw new Error(`MCP tool "${toolName}" is not allowed on an enabled server`);
    }
    return callMcpTool(tool.server, tool.toolName, args);
  },
  webhookHeaders: webhookHeaderValues,
  memory: databaseMemoryStore,
  loadSubflowVersion,
};

export function withAgentDependencies(
  overrides: Partial<AgentDependencies> | undefined,
): AgentDependencies {
  return { ...defaultAgentDependencies, ...overrides };
}
