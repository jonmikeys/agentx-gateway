import { describe, expect, it } from "vitest";
import { MAX_MCP_ROUNDS, mergeMcpTools } from "@/server/gateway/llm-proxy";
import {
  exposedToolName,
  MAX_TOOL_NAME_LENGTH,
  sanitizeToolSegment,
  validateExposedToolName,
  validateToolName,
} from "@/server/gateway/mcp-names";
import type { ResolvedMcpTool } from "@/server/services/mcp";

function tool(overrides: Partial<ResolvedMcpTool> = {}): ResolvedMcpTool {
  return {
    id: "tool-1",
    exposedName: "composio__echo",
    toolName: "echo",
    serverSlug: "composio",
    description: "Echo text",
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
    server: {
      id: "server-1",
      name: "Composio",
      slug: "composio",
      url: "https://mcp.example.com/mcp",
      transport: "streamable_http",
      headers: {},
    },
    ...overrides,
  };
}

describe("MCP tool names", () => {
  it("prefixes with the server slug and sanitises both segments", () => {
    expect(exposedToolName("composio", "GMAIL_SEND_EMAIL")).toBe("composio__GMAIL_SEND_EMAIL");
    expect(exposedToolName("my server!", "read/email")).toBe("my_server__read_email");
    expect(sanitizeToolSegment("   ")).toBe("");
  });

  it("validates OpenAI function names (64 chars, safe characters)", () => {
    expect(validateToolName("composio__echo")).toEqual({ ok: true });
    expect(validateToolName("bad name").ok).toBe(false);
    expect(validateToolName("x".repeat(MAX_TOOL_NAME_LENGTH + 1)).ok).toBe(false);
    const long = validateExposedToolName("s".repeat(60), "echo");
    expect(long.ok).toBe(false);
    expect(long.name.length).toBeGreaterThan(MAX_TOOL_NAME_LENGTH);
  });
});

describe("mergeMcpTools", () => {
  it("keeps client tools and appends allowed MCP tools", () => {
    const client = [
      { type: "function", function: { name: "show_image", parameters: { type: "object" } } },
    ];
    const merged = mergeMcpTools(client, [tool()]);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toEqual(client[0]);
    expect(merged[1]).toEqual({
      type: "function",
      function: {
        name: "composio__echo",
        description: "Echo text",
        parameters: { type: "object", properties: { text: { type: "string" } } },
      },
    });
  });

  it("never duplicates a name the client already declared", () => {
    const client = [
      { type: "function", function: { name: "composio__echo", parameters: { type: "object" } } },
    ];
    const merged = mergeMcpTools(client, [tool()]);
    expect(merged).toHaveLength(1);
  });

  it("defaults an empty input schema to an object schema", () => {
    const merged = mergeMcpTools(undefined, [tool({ inputSchema: {} })]) as {
      function: { parameters: unknown };
    }[];
    expect(merged[0].function.parameters).toEqual({ type: "object", properties: {} });
  });
});

describe("MCP round limit", () => {
  it("allows at most four upstream rounds", () => {
    expect(MAX_MCP_ROUNDS).toBe(4);
  });
});
