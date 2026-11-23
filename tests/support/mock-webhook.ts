import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Small HTTP server for webhook-node tests, e2e and screenshots. Self-contained so Playwright and
 * tsx can load it.
 *
 *   GET/POST /hook        -> 200 {"ok":true,"data":{"value":"hook-value"}}
 *   GET/POST /fail        -> 500 forever
 *   GET/POST /retry       -> fails the first `failures` calls (default 2), then 200 {"ok":true}
 *   GET/POST /echo        -> 200 {"echo": <request body or query text>}
 */
export interface MockWebhook {
  url: string;
  port: number;
  calls: { method: string; path: string; body: string }[];
  reset: () => void;
  close: () => Promise<void>;
}

export interface MockWebhookOptions {
  port?: number;
  /** How many times `/retry` answers 503 before succeeding. */
  failures?: number;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

export async function startMockWebhook(options: MockWebhookOptions = {}): Promise<MockWebhook> {
  const failures = options.failures ?? 2;
  const calls: MockWebhook["calls"] = [];
  let retryAttempts = 0;

  const server: Server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const body = request.method === "POST" ? await readBody(request) : "";
    calls.push({ method: request.method ?? "GET", path: url.pathname, body });

    if (url.pathname === "/hook") {
      send(response, 200, { ok: true, data: { value: "hook-value" } });
      return;
    }
    if (url.pathname === "/retry") {
      retryAttempts += 1;
      if (retryAttempts <= failures) {
        send(response, 503, { error: "not yet" });
        return;
      }
      send(response, 200, { ok: true, attempts: retryAttempts });
      return;
    }
    if (url.pathname === "/echo") {
      send(response, 200, { echo: body || url.searchParams.get("text") || "" });
      return;
    }
    send(response, 500, { error: "boom" });
  });

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    calls,
    reset: () => {
      calls.length = 0;
      retryAttempts = 0;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
