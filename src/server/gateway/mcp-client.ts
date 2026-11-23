import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpTransport } from "@/server/db/schema";

/** 30 s per MCP call in production; overridable in tests so the `slow` mock tool can time out. */
const DEFAULT_CALL_TIMEOUT_MS = 30_000;
const CONNECT_TIMEOUT_MS = 10_000;

let callTimeoutMs = DEFAULT_CALL_TIMEOUT_MS;

/** Integration tests point this at a few hundred milliseconds. */
export function setMcpCallTimeoutForTests(ms: number): void {
  callTimeoutMs = ms;
}

export function resetMcpCallTimeout(): void {
  callTimeoutMs = DEFAULT_CALL_TIMEOUT_MS;
}

/** One registered server with decrypted headers; never serialized. */
export interface McpServerRuntime {
  id: string;
  name: string;
  slug: string;
  url: string;
  transport: McpTransport;
  headers: Record<string, string>;
}

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: unknown;
}

export interface McpToolCallResult {
  text: string;
  isError: boolean;
}

interface PoolEntry {
  signature: string;
  client: Promise<Client>;
}

const pool = new Map<string, PoolEntry>();

function signature(server: McpServerRuntime): string {
  return JSON.stringify({
    url: server.url,
    transport: server.transport,
    headers: server.headers,
  });
}

function asHeaders(init: HeadersInit | undefined, extra: Record<string, string>): Headers {
  const headers = new Headers(init);
  for (const [name, value] of Object.entries(extra)) headers.set(name, value);
  return headers;
}

async function connect(server: McpServerRuntime): Promise<Client> {
  const transport =
    server.transport === "sse"
      ? new SSEClientTransport(new URL(server.url), {
          requestInit: { headers: server.headers },
          eventSourceInit: {
            fetch: (input, init) =>
              fetch(input, { ...init, headers: asHeaders(init?.headers, server.headers) }),
          },
        })
      : new StreamableHTTPClientTransport(new URL(server.url), {
          requestInit: { headers: server.headers },
        });
  const client = new Client({ name: "agentx-gateway", version: "0.1.0" }, { capabilities: {} });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      void client.close().catch(() => {});
      reject(new Error(`Connecting to MCP server "${server.name}" timed out`));
    }, CONNECT_TIMEOUT_MS);
  });
  try {
    await Promise.race([client.connect(transport), timeout]);
    return client;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function invalidate(serverId: string): void {
  const entry = pool.get(serverId);
  if (!entry) return;
  pool.delete(serverId);
  void entry.client.then((client) => client.close()).catch(() => {});
}

/** Drops every pooled connection (tests and admin disconnect). */
export function resetMcpClients(): void {
  for (const id of [...pool.keys()]) invalidate(id);
}

async function clientFor(server: McpServerRuntime): Promise<Client> {
  const wanted = signature(server);
  const existing = pool.get(server.id);
  if (existing?.signature === wanted) {
    try {
      return await existing.client;
    } catch {
      pool.delete(server.id);
    }
  } else if (existing) {
    invalidate(server.id);
  }
  const promise = connect(server);
  pool.set(server.id, { signature: wanted, client: promise });
  try {
    return await promise;
  } catch (error) {
    pool.delete(server.id);
    throw error;
  }
}

function describeResult(result: {
  content?: unknown;
  structuredContent?: unknown;
  isError?: boolean;
}): McpToolCallResult {
  const parts: string[] = [];
  const content = Array.isArray(result.content) ? result.content : [];
  for (const raw of content) {
    if (typeof raw !== "object" || raw === null) continue;
    const item = raw as Record<string, unknown>;
    if (item.type === "text" && typeof item.text === "string") {
      parts.push(item.text);
    } else if (item.type === "image") {
      parts.push(`[image: ${String(item.mimeType ?? "unknown")}]`);
    } else if (item.type === "resource") {
      parts.push(JSON.stringify(item.resource ?? item));
    } else {
      parts.push(JSON.stringify(item));
    }
  }
  if (parts.length === 0 && result.structuredContent !== undefined) {
    parts.push(JSON.stringify(result.structuredContent));
  }
  return { text: parts.join("\n"), isError: result.isError === true };
}

async function listWith(client: Client): Promise<McpToolInfo[]> {
  const result = await client.listTools(undefined, { timeout: callTimeoutMs });
  return result.tools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? "",
    inputSchema: tool.inputSchema ?? {},
  }));
}

/**
 * Connects (or reuses a pooled connection) and lists the server's tools. A dead pooled
 * connection (the server restarted, for example) is dropped and the call retried once.
 */
export async function listMcpServerTools(server: McpServerRuntime): Promise<McpToolInfo[]> {
  try {
    return await listWith(await clientFor(server));
  } catch {
    invalidate(server.id);
    try {
      return await listWith(await clientFor(server));
    } catch (error) {
      invalidate(server.id);
      throw error;
    }
  }
}

/** Calls one tool with the production timeout; a failure drops the pooled client. */
export async function callMcpTool(
  server: McpServerRuntime,
  toolName: string,
  args: unknown,
): Promise<McpToolCallResult> {
  const client = await clientFor(server);
  try {
    const result = await client.callTool(
      { name: toolName, arguments: (args ?? {}) as Record<string, unknown> },
      undefined,
      { timeout: callTimeoutMs },
    );
    return describeResult(result as never);
  } catch (error) {
    invalidate(server.id);
    throw error;
  }
}
