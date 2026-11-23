import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * OpenAI-compatible mock upstream for tests, e2e and manual demos. Behaviour is chosen by the
 * request's `model`:
 *   ok               normal reply (stream or JSON, with usage)
 *   fail-500|502|503 / fail-408 / fail-429   failover-class errors
 *   fail-401|403 / fail-404                  auth / not found errors (no failover)
 *   bad-request-400 / bad-request-422        invalid request errors (no failover)
 *   slow             waits `slowMs` (default 1500 ms) before answering (exceeds small timeouts)
 *   midstream-fail   streams two chunks, then destroys the socket
 *   empty-stream     200 with an empty body
 * Self-contained (no `@/` imports) so Playwright and tsx can run it.
 */
export interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown> | undefined;
}

export interface MockUpstream {
  url: string;
  port: number;
  requests: RecordedRequest[];
  /** Requests received for `/chat/completions` only. */
  chatRequests: () => RecordedRequest[];
  reset: () => void;
  close: () => Promise<void>;
}

export interface MockUpstreamOptions {
  port?: number;
  /** When set, requests without `Authorization: Bearer <apiKey>` get 401. */
  apiKey?: string;
  slowMs?: number;
  models?: string[];
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

function sendError(response: ServerResponse, status: number, message: string): void {
  sendJson(response, status, { error: { message, type: "mock_error", code: `mock_${status}` } });
}

function chunk(content: string, finishReason: string | null = null): string {
  return `data: ${JSON.stringify({
    id: "chatcmpl-mock",
    object: "chat.completion.chunk",
    created: 1,
    model: "mock",
    choices: [{ index: 0, delta: content ? { content } : {}, finish_reason: finishReason }],
  })}\n\n`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function startMockUpstream(options: MockUpstreamOptions = {}): Promise<MockUpstream> {
  const requests: RecordedRequest[] = [];
  const slowMs = options.slowMs ?? 1500;
  const models = options.models ?? ["ok", "mock-model"];

  const server: Server = createServer(async (request, response) => {
    const rawBody = request.method === "POST" ? await readBody(request) : "";
    let body: Record<string, unknown> | undefined;
    try {
      body = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : undefined;
    } catch {
      body = undefined;
    }
    const path = (request.url ?? "").split("?")[0];
    requests.push({ method: request.method ?? "GET", path, headers: request.headers, body });

    if (options.apiKey && request.headers.authorization !== `Bearer ${options.apiKey}`) {
      sendError(response, 401, "Incorrect API key provided.");
      return;
    }

    if (request.method === "GET" && path === "/models") {
      sendJson(response, 200, {
        object: "list",
        data: models.map((id) => ({ id, object: "model", owned_by: "mock" })),
      });
      return;
    }

    if (request.method !== "POST" || path !== "/chat/completions") {
      sendError(response, 404, `Unknown route ${path}`);
      return;
    }

    const model = String(body?.model ?? "ok");
    const stream = body?.stream === true;
    const failure = /^(fail|bad-request)-(\d{3})$/.exec(model);
    if (failure) {
      sendError(response, Number(failure[2]), `Mock ${model}`);
      return;
    }
    if (model === "slow") await sleep(slowMs);
    if (model === "empty-stream") {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end();
      return;
    }

    const usage = { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 };
    if (!stream) {
      sendJson(response, 200, {
        id: "chatcmpl-mock",
        object: "chat.completion",
        created: 1,
        model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "Hello there" },
            finish_reason: "stop",
          },
        ],
        usage,
      });
      return;
    }

    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    response.write(chunk("Hel"));
    await sleep(15);
    if (model === "midstream-fail") {
      response.write(chunk("lo"));
      await sleep(15);
      request.socket.destroy();
      return;
    }
    response.write(chunk("lo "));
    await sleep(15);
    response.write(chunk("there", "stop"));
    const streamOptions = body?.stream_options as { include_usage?: boolean } | undefined;
    if (streamOptions?.include_usage) {
      response.write(
        `data: ${JSON.stringify({ id: "chatcmpl-mock", object: "chat.completion.chunk", choices: [], usage })}\n\n`,
      );
    }
    response.write("data: [DONE]\n\n");
    response.end();
  });

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    chatRequests: () => requests.filter((entry) => entry.path === "/chat/completions"),
    reset: () => {
      requests.length = 0;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
