import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

/**
 * Small MCP server for tests, e2e and demos. Stateful Streamable HTTP under `/mcp` with four
 * tools: `echo` (text), `add` (numbers), `slow` (waits longer than a test timeout) and `fail`
 * (returns a tool error). Built with the official SDK so the gateway's client exercises the real
 * protocol. Self-contained (no `@/` imports) so Playwright and tsx can run it.
 */
export interface MockMcpOptions {
  port?: number;
  /** How long `slow` waits; integration tests set their gateway timeout below it. */
  slowMs?: number;
}

export interface MockMcpCall {
  tool: string;
  args: Record<string, unknown>;
}

export interface MockMcp {
  url: string;
  port: number;
  calls: MockMcpCall[];
  reset: () => void;
  close: () => Promise<void>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function buildServer(slowMs: number, calls: MockMcpCall[]): McpServer {
  const server = new McpServer({ name: "mock-mcp", version: "0.1.0" });

  server.registerTool(
    "echo",
    {
      description: "Echo the given text back.",
      inputSchema: { text: z.string().optional() },
    },
    async ({ text }) => {
      calls.push({ tool: "echo", args: { text: text ?? "" } });
      return { content: [{ type: "text", text: `Echo: ${text ?? ""}` }] };
    },
  );

  server.registerTool(
    "add",
    {
      description: "Add two numbers.",
      inputSchema: { a: z.number(), b: z.number() },
    },
    async ({ a, b }) => {
      calls.push({ tool: "add", args: { a, b } });
      return { content: [{ type: "text", text: `${a} + ${b} = ${a + b}` }] };
    },
  );

  server.registerTool(
    "slow",
    {
      description: "Waits before answering (exceeds small timeouts).",
      inputSchema: { text: z.string().optional() },
    },
    async ({ text }) => {
      calls.push({ tool: "slow", args: { text: text ?? "" } });
      await sleep(slowMs);
      return { content: [{ type: "text", text: `Slow: ${text ?? ""}` }] };
    },
  );

  server.registerTool(
    "fail",
    {
      description: "Always returns a tool error.",
      inputSchema: { text: z.string().optional() },
    },
    async ({ text }) => {
      calls.push({ tool: "fail", args: { text: text ?? "" } });
      return {
        isError: true,
        content: [{ type: "text", text: `Mock tool failure: ${text ?? "no text"}` }],
      };
    },
  );

  return server;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

export async function startMockMcp(options: MockMcpOptions = {}): Promise<MockMcp> {
  const slowMs = options.slowMs ?? 500;
  const calls: MockMcpCall[] = [];
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const servers = new Map<string, McpServer>();

  const forget = (transport: StreamableHTTPServerTransport) => {
    for (const [id, candidate] of transports) {
      if (candidate !== transport) continue;
      transports.delete(id);
      const server = servers.get(id);
      servers.delete(id);
      void server?.close().catch(() => {});
    }
  };

  const httpServer: Server = createServer(async (request, response) => {
    const path = (request.url ?? "").split("?")[0];
    if (path !== "/mcp") {
      sendJson(response, 404, { error: "not_found" });
      return;
    }
    const raw = request.method === "POST" ? await readBody(request) : "";
    let body: unknown;
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        sendJson(response, 400, { error: "invalid_json" });
        return;
      }
    }
    const sessionId = request.headers["mcp-session-id"];
    if (typeof sessionId === "string" && sessionId.length > 0) {
      const transport = transports.get(sessionId);
      if (!transport) {
        sendJson(response, 404, { error: "unknown_session" });
        return;
      }
      await transport.handleRequest(request, response, body);
      return;
    }
    const server = buildServer(slowMs, calls);
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        transports.set(id, transport);
        servers.set(id, server);
      },
    });
    transport.onclose = () => forget(transport);
    await server.connect(transport);
    await transport.handleRequest(request, response, body);
  });

  await new Promise<void>((resolve) => httpServer.listen(options.port ?? 0, "127.0.0.1", resolve));
  const port = (httpServer.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    port,
    calls,
    reset: () => {
      calls.length = 0;
    },
    close: async () => {
      for (const transport of [...transports.values()]) void transport.close().catch(() => {});
      for (const server of [...servers.values()]) void server.close().catch(() => {});
      transports.clear();
      servers.clear();
      httpServer.closeAllConnections();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}
