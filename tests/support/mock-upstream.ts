import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { handleResponses } from "./mock-responses";

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
 *   reasoning        streams `reasoning_content` (then `reasoning`) before the answer
 *   think-tags       streams the thinking inside <think>...</think> tags split across chunks
 *   tool-call        asks for the client tool `show_image`; after a tool result it answers in text
 *   echo             answers "Echo: <last user message>" (for search and redaction tests)
 *   gateway-tool     the last user message is JSON `{"tool": name, "args": {...}}`: calls that
 *                    tool once, then answers "Result: <tool result>" (built-in tool tests)
 * `POST /responses` (native Responses API, see mock-responses.ts) supports the same switches.
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
  /** Requests received for `/responses` only. */
  responsesRequests: () => RecordedRequest[];
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

type Delta = Record<string, unknown>;

function toolCallDelta(index: number, id: string, name: string, args: string): Delta {
  return {
    tool_calls: [{ index, id, type: "function", function: { name, arguments: args } }],
  };
}

function messageList(body: Record<string, unknown> | undefined): Record<string, unknown>[] {
  return Array.isArray(body?.messages) ? (body.messages as Record<string, unknown>[]) : [];
}

function lastToolContent(messages: Record<string, unknown>[]): string {
  const tool = [...messages].reverse().find((message) => message.role === "tool");
  return typeof tool?.content === "string" ? tool.content : "";
}

function toolRound(messages: Record<string, unknown>[]): number {
  return messages.filter((message) => message.role === "tool").length;
}

/** Finds the exposed MCP tool name for a suffix (`echo` -> `composio__echo` or `mock__echo`). */
function mcpToolName(body: Record<string, unknown> | undefined, suffix: string): string {
  const tools = Array.isArray(body?.tools) ? (body.tools as Record<string, unknown>[]) : [];
  for (const tool of tools) {
    const fn = tool.function as Record<string, unknown> | undefined;
    const name = typeof fn?.name === "string" ? fn.name : undefined;
    if (name?.endsWith(`__${suffix}`)) return name;
  }
  return `mock__${suffix}`;
}

/** Delta sequence for a model behaviour; each entry becomes one SSE chunk. */
function scriptedDeltas(
  model: string,
  body: Record<string, unknown> | undefined,
): Delta[] | undefined {
  const messages = messageList(body);
  const { role: lastRole, user: lastUserText } = lastMessage(body);
  const toolContent = lastToolContent(messages);
  const round = toolRound(messages);
  switch (model) {
    case "reasoning":
      return [
        { reasoning_content: "The user greets me. " },
        { reasoning: "I should answer warmly." },
        { content: "Hello " },
        { content: "from the reasoning model." },
      ];
    case "think-tags":
      return [
        { content: "<thi" },
        { content: "nk>Considering the " },
        { content: "request carefully.</th" },
        { content: "ink>Here is my " },
        { content: "considered answer." },
      ];
    case "tool-call":
      if (lastRole === "tool") {
        return [{ content: "Done! " }, { content: "I put the image on screen." }];
      }
      return [
        { content: "Let me show that. " },
        {
          tool_calls: [
            {
              index: 0,
              id: "call_mock_1",
              type: "function",
              function: { name: "show_image", arguments: "" },
            },
          ],
        },
        { tool_calls: [{ index: 0, function: { arguments: '{"media_id":' } }] },
        { tool_calls: [{ index: 0, function: { arguments: '"sunset"}' } }] },
      ];
    case "echo":
      return [{ content: "Echo: " }, { content: lastUserText }];
    case "gateway-tool": {
      if (lastRole === "tool") return [{ content: `Result: ${toolContent}` }];
      let spec: { tool?: string; args?: unknown } = {};
      try {
        spec = JSON.parse(lastUserText) as typeof spec;
      } catch {
        return [{ content: "Send JSON with a tool name." }];
      }
      return [
        toolCallDelta(
          0,
          `call_gateway_${round}`,
          String(spec.tool ?? "unknown"),
          JSON.stringify(spec.args ?? {}),
        ),
      ];
    }
    case "mcp-echo":
      if (lastRole === "tool") return [{ content: `Answer: ${toolContent}` }];
      return [
        { content: "Checking. " },
        toolCallDelta(0, "call_mcp_echo", mcpToolName(body, "echo"), '{"text":"hello"}'),
      ];
    case "mcp-add":
      if (lastRole === "tool") return [{ content: `Sum: ${toolContent}` }];
      return [toolCallDelta(0, "call_mcp_add", mcpToolName(body, "add"), '{"a":2,"b":3}')];
    case "mcp-multi":
      if (round === 0) {
        return [toolCallDelta(0, "call_multi_1", mcpToolName(body, "echo"), '{"text":"one"}')];
      }
      if (round === 1) {
        return [toolCallDelta(0, "call_multi_2", mcpToolName(body, "add"), '{"a":4,"b":5}')];
      }
      return [{ content: `Multi done: ${toolContent}` }];
    case "mcp-mixed":
      if (lastRole === "tool" && round > 0) return [{ content: "Mixed done." }];
      return [
        { content: "Mixed. " },
        toolCallDelta(0, "call_client_mixed", "show_image", '{"media_id":"sunset"}'),
        toolCallDelta(1, "call_mcp_mixed", mcpToolName(body, "echo"), '{"text":"mixed"}'),
      ];
    case "mcp-limit":
      if (body?.tool_choice === "none") return [{ content: "Limit reached." }];
      return [toolCallDelta(0, "call_limit", mcpToolName(body, "echo"), '{"text":"loop"}')];
    case "mcp-timeout":
      if (lastRole === "tool") return [{ content: `Timeout feed: ${toolContent}` }];
      return [toolCallDelta(0, "call_slow", mcpToolName(body, "slow"), '{"text":"slow"}')];
    case "mcp-fail":
      if (lastRole === "tool") return [{ content: `Failure feed: ${toolContent}` }];
      return [toolCallDelta(0, "call_fail", mcpToolName(body, "fail"), '{"text":"fail"}')];
    default:
      return undefined;
  }
}

function lastMessage(body: Record<string, unknown> | undefined): { role: string; user: string } {
  const messages = Array.isArray(body?.messages)
    ? (body.messages as Record<string, unknown>[])
    : [];
  const last = messages.at(-1);
  const lastUser = [...messages].reverse().find((message) => message.role === "user");
  return {
    role: String(last?.role ?? ""),
    user: typeof lastUser?.content === "string" ? lastUser.content : "",
  };
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

    if (request.method === "POST" && path === "/responses") {
      await handleResponses(request, response, body, slowMs, sendError);
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
    const scripted = scriptedDeltas(model, body);
    if (scripted) {
      const calls: { id: string; name: string; args: string }[] = [];
      for (const delta of scripted) {
        if (!Array.isArray(delta.tool_calls)) continue;
        for (const raw of delta.tool_calls as Record<string, unknown>[]) {
          const index = typeof raw.index === "number" ? raw.index : calls.length;
          const fn = (raw.function ?? {}) as Record<string, unknown>;
          const existing = calls[index];
          calls[index] = {
            id: typeof raw.id === "string" ? raw.id : (existing?.id ?? `call_${index}`),
            name: typeof fn.name === "string" ? fn.name : (existing?.name ?? ""),
            args: (existing?.args ?? "") + (typeof fn.arguments === "string" ? fn.arguments : ""),
          };
        }
      }
      if (!stream) {
        const message: Record<string, unknown> = {
          role: "assistant",
          content: scripted.map((delta) => String(delta.content ?? "")).join("") || null,
        };
        const reasoning = scripted.map((delta) => String(delta.reasoning_content ?? "")).join("");
        if (reasoning) message.reasoning_content = reasoning;
        if (calls.length > 0) {
          message.tool_calls = calls.map((call) => ({
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: call.args },
          }));
        }
        sendJson(response, 200, {
          id: "chatcmpl-mock",
          object: "chat.completion",
          created: 1,
          model,
          choices: [{ index: 0, message, finish_reason: calls.length > 0 ? "tool_calls" : "stop" }],
          usage,
        });
        return;
      }
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      for (const delta of scripted) {
        response.write(
          `data: ${JSON.stringify({
            id: "chatcmpl-mock",
            object: "chat.completion.chunk",
            created: 1,
            model: "mock",
            choices: [{ index: 0, delta, finish_reason: null }],
          })}\n\n`,
        );
        await sleep(10);
      }
      response.write(
        `data: ${JSON.stringify({
          id: "chatcmpl-mock",
          object: "chat.completion.chunk",
          choices: [
            { index: 0, delta: {}, finish_reason: calls.length > 0 ? "tool_calls" : "stop" },
          ],
        })}\n\n`,
      );
      const scriptedStreamOptions = body?.stream_options as { include_usage?: boolean } | undefined;
      if (scriptedStreamOptions?.include_usage) {
        response.write(
          `data: ${JSON.stringify({ id: "chatcmpl-mock", object: "chat.completion.chunk", choices: [], usage })}\n\n`,
        );
      }
      response.write("data: [DONE]\n\n");
      response.end();
      return;
    }
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
    responsesRequests: () => requests.filter((entry) => entry.path === "/responses"),
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
