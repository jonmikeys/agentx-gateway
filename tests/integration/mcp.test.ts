import { desc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { createApiApp } from "@/server/api/app";
import { encryptedColumns } from "@/server/crypto/encrypted-columns";
import { rotateSecrets } from "@/server/crypto/rotate";
import { decryptSecretWithKey, generateEncryptionKey } from "@/server/crypto/secrets";
import { closeDatabase, createSql, getDb } from "@/server/db/client";
import { llmRequests, mcpServers } from "@/server/db/schema";
import { setMcpCallTimeoutForTests } from "@/server/gateway/mcp-client";
import {
  createMcpServer,
  getMcpServer,
  listMcpTools,
  refreshMcpTools,
  setMcpToolAllowed,
} from "@/server/services/mcp";
import { findSessionDetail } from "@/server/services/session-queries";
import { type MockMcp, startMockMcp } from "../support/mock-mcp";
import { type MockUpstream, startMockUpstream } from "../support/mock-upstream";
import {
  prepareDatabase,
  resetGatewayState,
  seedApiKey,
  seedProvider,
  seedRoute,
  waitFor,
} from "./support";

const databaseUrl = inject("databaseUrl");

interface SeededMcp {
  serverId: string;
  toolIds: Record<string, string>;
}

describe("MCP registry and plain-chat tool loop", () => {
  const app = createApiApp();
  let upstream: MockUpstream;
  let mcp: MockMcp;
  let key: string;
  let providerId: string;
  let seeded: SeededMcp;

  beforeAll(async () => {
    await prepareDatabase(databaseUrl);
    upstream = await startMockUpstream();
    mcp = await startMockMcp({ slowMs: 800 });
    // Keep timeouts short so the `slow` tool exceeds them.
    setMcpCallTimeoutForTests(250);
  });

  afterAll(async () => {
    // Other test files share this database; never leave encrypted MCP rows behind.
    await resetGatewayState();
    await upstream.close();
    await mcp.close();
    await closeDatabase();
  });

  afterEach(() => {
    upstream.reset();
    mcp.reset();
  });

  beforeEach(async () => {
    await resetGatewayState();
    setMcpCallTimeoutForTests(250);
    const provider = await seedProvider("Mock", upstream.url);
    providerId = provider.id;
    const created = await seedApiKey();
    key = created.key;
    seeded = await seedMcpServer();
  });

  async function seedMcpServer(
    allow: string[] = ["echo", "add", "slow", "fail"],
  ): Promise<SeededMcp> {
    const server = await createMcpServer({
      name: "Mock MCP",
      slug: "mock",
      url: mcp.url,
      transport: "streamable_http",
      headers: { "x-api-key": "mcp-secret-value" },
      enabled: true,
    });
    await refreshMcpTools(server.id);
    const tools = await listMcpTools(server.id);
    const toolIds: Record<string, string> = {};
    for (const tool of tools) {
      toolIds[tool.name] = tool.id;
      if (allow.includes(tool.name)) await setMcpToolAllowed(tool.id, true);
    }
    return { serverId: server.id, toolIds };
  }

  function routeWith(toolNames: string[], model: string) {
    return seedRoute(
      "mcp-route",
      [{ providerId, model }],
      true,
      toolNames.map((name) => seeded.toolIds[name]).filter(Boolean),
    );
  }

  function chat(body: Record<string, unknown>, sessionId?: string) {
    return app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        ...(sessionId ? { "X-Session-Id": sessionId } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  function responses(body: Record<string, unknown>, sessionId?: string) {
    return app.request("/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        ...(sessionId ? { "X-Session-Id": sessionId } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  const userMessage = [{ role: "user", content: "please use the tool" }];

  it("runs a single MCP round and answers with the tool result", async () => {
    await routeWith(["echo"], "mcp-echo");
    const response = await chat({ model: "mcp-route", messages: userMessage });
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.choices[0].message.content).toBe("Answer: Echo: hello");
    expect(upstream.chatRequests()).toHaveLength(2);
    // The model saw the exposed name, not the raw tool name.
    const offered = upstream.chatRequests()[0].body?.tools as { function: { name: string } }[];
    expect(offered.map((tool) => tool.function.name)).toContain("mock__echo");
    expect(mcp.calls).toEqual([{ tool: "echo", args: { text: "hello" } }]);
  });

  it("loops through several MCP rounds", async () => {
    await routeWith(["echo", "add"], "mcp-multi");
    const response = await chat({ model: "mcp-route", messages: userMessage });
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.choices[0].message.content).toBe("Multi done: 4 + 5 = 9");
    expect(upstream.chatRequests()).toHaveLength(3);
    expect(mcp.calls.map((call) => call.tool)).toEqual(["echo", "add"]);
  });

  it("stops at four rounds and calls the last one with tool_choice none", async () => {
    await routeWith(["echo"], "mcp-limit");
    const response = await chat({ model: "mcp-route", messages: userMessage });
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.choices[0].message.content).toBe("Limit reached.");
    const requests = upstream.chatRequests();
    expect(requests).toHaveLength(4);
    expect(requests.at(-1)?.body?.tool_choice).toBe("none");
  });

  it("feeds a tool timeout back to the model", async () => {
    await routeWith(["slow"], "mcp-timeout");
    const response = await chat({ model: "mcp-route", messages: userMessage });
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.choices[0].message.content).toContain("Timeout feed: Error:");
    expect(upstream.chatRequests()).toHaveLength(2);
  });

  it("feeds a tool error result back to the model", async () => {
    await routeWith(["fail"], "mcp-fail");
    const response = await chat({ model: "mcp-route", messages: userMessage });
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.choices[0].message.content).toBe("Failure feed: Mock tool failure: fail");
  });

  it("returns only client calls for a mixed reply and re-injects MCP messages next turn", async () => {
    await routeWith(["echo"], "mcp-mixed");
    const first = await chat({ model: "mcp-route", messages: userMessage });
    const firstJson = await first.json();
    const calls = firstJson.choices[0].message.tool_calls as {
      id: string;
      function: { name: string };
    }[];
    expect(calls.map((call) => call.function.name)).toEqual(["show_image"]);
    expect(mcp.calls.map((call) => call.tool)).toEqual(["echo"]);

    const sessionId = first.headers.get("x-session-id") as string;
    const second = await chat(
      {
        model: "mcp-route",
        messages: [
          ...userMessage,
          {
            role: "assistant",
            content: "Mixed. ",
            tool_calls: calls,
          },
          { role: "tool", tool_call_id: "call_client_mixed", content: "Image shown" },
        ],
      },
      sessionId,
    );
    expect(second.status).toBe(200);
    expect((await second.json()).choices[0].message.content).toBe("Mixed done.");

    const secondBody = upstream.chatRequests().at(-1)?.body;
    const messages = secondBody?.messages as Record<string, unknown>[];
    const injectedAssistant = messages.find(
      (message) =>
        message.role === "assistant" &&
        Array.isArray(message.tool_calls) &&
        (message.tool_calls as { function: { name: string } }[]).some(
          (call) => call.function.name === "mock__echo",
        ),
    );
    expect(injectedAssistant).toBeDefined();
    const injectedTool = messages.find(
      (message) => message.role === "tool" && message.tool_call_id === "call_mcp_mixed",
    );
    expect(injectedTool?.content).toBe("Echo: mixed");
  });

  it("never offers or executes MCP tools that are not on the route", async () => {
    // `add` is allowed globally but not selected on this route.
    await routeWith(["echo"], "mcp-add");
    const response = await chat({ model: "mcp-route", messages: userMessage });
    expect(response.status).toBe(200);
    const offered = upstream.chatRequests()[0].body?.tools as { function: { name: string } }[];
    expect(offered.map((tool) => tool.function.name)).not.toContain("mock__add");
    expect(mcp.calls).toHaveLength(0);
  });

  it("works through /v1/responses (stream, translated) as well", async () => {
    await routeWith(["echo"], "mcp-echo");
    const response = await responses({
      model: "mcp-route",
      stream: true,
      input: [{ role: "user", content: "please use the tool" }],
    });
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("response.output_text.delta");
    expect(body).toContain("Answer: Echo: hello");
    expect(body).toContain("response.completed");
  });

  it("records MCP transcript items with tool_source mcp", async () => {
    await routeWith(["echo"], "mcp-echo");
    const response = await chat({ model: "mcp-route", messages: userMessage });
    await response.text();
    const sessionId = response.headers.get("x-session-id") as string;
    const items = await waitFor(async () => {
      const detail = await findSessionDetail(sessionId);
      const mcpItems = detail?.turns.flatMap((turn) =>
        turn.items.filter((item) => item.tool_source === "mcp"),
      );
      return mcpItems && mcpItems.length >= 2 ? mcpItems : undefined;
    });
    expect(items.map((item) => item.kind)).toEqual(["tool_call", "tool_result"]);
    expect(items[0].tool_name).toBe("mock__echo");
    expect(items[1].content).toBe("Echo: hello");
    expect(items[1].duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("encrypts headers at rest, never returns them, and rotates them", async () => {
    const [row] = await getDb().select().from(mcpServers).where(eq(mcpServers.id, seeded.serverId));
    expect(row.headers?.startsWith("v1:")).toBe(true);
    expect(row.headers).not.toContain("mcp-secret-value");

    const view = await getMcpServer(seeded.serverId);
    expect(JSON.stringify(view)).not.toContain("mcp-secret-value");
    expect(view.headers_masked?.[0].name).toBe("x-api-key");
    expect(view.headers_masked?.[0].value).not.toBe("mcp-secret-value");

    const oldKey = process.env.GATEWAY_ENCRYPTION_KEY as string;
    const newKey = generateEncryptionKey();
    const sql = createSql(databaseUrl, { max: 1, onnotice: () => {} });
    try {
      const rotated = await rotateSecrets(sql, oldKey, newKey, encryptedColumns);
      expect(rotated).toBe(1);
      const [after] = await sql<{ headers: string }[]>`
        select headers from mcp_servers where id = ${seeded.serverId}`;
      expect(decryptSecretWithKey(after.headers, newKey)).toContain("mcp-secret-value");
    } finally {
      await sql.end({ timeout: 2 });
    }
  });

  it("writes request rows without leaking tool arguments or results", async () => {
    await routeWith(["echo"], "mcp-echo");
    await chat({ model: "mcp-route", messages: userMessage });
    const row = await waitFor(async () => {
      const [found] = await getDb()
        .select()
        .from(llmRequests)
        .orderBy(desc(llmRequests.startedAt))
        .limit(1);
      return found;
    });
    expect(row).toMatchObject({ status: "ok", clientApi: "chat" });
    expect(JSON.stringify(row)).not.toContain("Echo: hello");
    expect(JSON.stringify(row)).not.toContain("mcp-secret-value");
  });
});
