import { randomUUID } from "node:crypto";
import { openAIError } from "@/server/api/errors";
import type { LlmApi, RequestAttempt, TokenUsage } from "@/server/db/schema";
import { type CircuitBreaker, circuitBreaker } from "@/server/gateway/circuit-breaker";
import { callMcpTool } from "@/server/gateway/mcp-client";
import { chatCompletionToResponse } from "@/server/gateway/responses/response-translate";
import {
  ChatToResponsesStream,
  type ResponseEvent,
} from "@/server/gateway/responses/stream-translate";
import {
  formatSse,
  formatSseEvent,
  SSE_DONE,
  type SseEvent,
  SseParser,
} from "@/server/gateway/sse";
import { convertJsonBody, createStreamPipe, type StreamPipe } from "@/server/gateway/stream-pipes";
import {
  type CapturedResponse,
  type CapturedToolCall,
  ResponseCapture,
} from "@/server/gateway/transcript/response-capture";
import {
  classifyStatus,
  extractUpstreamMessage,
  type MappedError,
  mapUpstreamError,
} from "@/server/gateway/upstream-errors";
import { extractUsage } from "@/server/gateway/usage";
import { savePendingMcpMessages, takePendingMcpMessages } from "@/server/services/mcp";
import type { ResolvedRoute, ResolvedStep } from "@/server/services/routes";

/** At most four upstream rounds on a route with MCP tools; the fourth is called with none. */
export const MAX_MCP_ROUNDS = 4;

/** One MCP call observed during a request, persisted as transcript items (tool_source = mcp). */
export interface McpTranscriptItem {
  kind: "tool_call" | "tool_result";
  toolCallId: string;
  toolName: string;
  toolArgs?: unknown;
  content?: string;
  durationMs: number | null;
  isError?: boolean;
}

export { extractUsage };

/** Everything the caller needs to persist one `llm_requests` row. Contains no message content. */
export interface RequestOutcome {
  routeSlug: string;
  /** API the client spoke. */
  clientApi: LlmApi;
  /** API the answering provider was called with; absent when no provider answered. */
  upstreamApi?: LlmApi;
  providerId?: string;
  upstreamModel?: string;
  stream: boolean;
  status: "ok" | "error";
  httpStatus: number;
  errorCode?: string;
  /** Gateway/upstream error text (never client content); stored as a transcript error item. */
  errorMessage?: string;
  startedAt: Date;
  durationMs: number;
  ttftMs?: number;
  attempts: RequestAttempt[];
  usage?: TokenUsage;
  /** What the assistant produced; held in memory and persisted by the caller after completion. */
  captured?: CapturedResponse;
  /** MCP calls executed by the gateway during this request. */
  mcpItems?: McpTranscriptItem[];
}

export interface LlmProxyInput {
  /** API the client spoke; decides the response format. */
  clientApi: LlmApi;
  /**
   * Request body in the client's own format with gateway-only fields already stripped. Sent
   * (with `model` rewritten) to steps whose upstream API equals the client API.
   */
  body: Record<string, unknown>;
  /** Chat Completions equivalent of `body`; required for Responses requests that may be translated. */
  chatBody?: Record<string, unknown>;
  stream: boolean;
  route: ResolvedRoute;
  clientSignal: AbortSignal;
  onComplete: (outcome: RequestOutcome) => void;
  /** Extra headers (for example `X-Session-Id`) set on every response, before the first byte. */
  responseHeaders?: Record<string, string>;
  breaker?: CircuitBreaker;
  fetchImpl?: typeof fetch;
  /** Needed to re-inject mixed-round MCP messages and to persist new pending ones. */
  sessionId?: string;
}

type StepResult =
  | {
      type: "stream";
      reader: ReadableStreamDefaultReader<Uint8Array>;
      parser: SseParser;
      decoder: TextDecoder;
      firstEvents: SseEvent[];
      abort: () => void;
    }
  | { type: "json"; text: string; usage?: TokenUsage }
  | { type: "failover"; outcome: string; errorCode: string; httpStatus?: number }
  | { type: "reject"; mapped: MappedError; httpStatus: number }
  | { type: "client_aborted" };

/** Builds the Chat Completions body: model rewritten, usage reporting requested for streams. */
export function buildUpstreamBody(
  body: Record<string, unknown>,
  upstreamModel: string,
  stream: boolean,
): Record<string, unknown> {
  const upstream: Record<string, unknown> = { ...body, model: upstreamModel };
  if (stream) {
    upstream.stream = true;
    // Respect a client-provided stream_options value.
    if (upstream.stream_options === undefined) upstream.stream_options = { include_usage: true };
  }
  return upstream;
}

/** Builds the Responses body for a native step: model rewritten, everything else as sent. */
export function buildNativeResponsesBody(
  body: Record<string, unknown>,
  upstreamModel: string,
  stream: boolean,
): Record<string, unknown> {
  const upstream: Record<string, unknown> = { ...body, model: upstreamModel };
  if (stream) upstream.stream = true;
  return upstream;
}

/** Which API a step is called with: native Responses only when the client and the provider agree. */
export function upstreamApiFor(clientApi: LlmApi, step: ResolvedStep): LlmApi {
  return clientApi === "responses" && step.provider.capabilities.responses_api
    ? "responses"
    : "chat";
}

const UPSTREAM_PATHS: Record<LlmApi, string> = {
  chat: "/chat/completions",
  responses: "/responses",
};

function buildHeaders(step: ResolvedStep, stream: boolean): Headers {
  const headers = new Headers({
    "Content-Type": "application/json",
    Accept: stream ? "text/event-stream" : "application/json",
  });
  if (step.provider.apiKey) headers.set("Authorization", `Bearer ${step.provider.apiKey}`);
  for (const [name, value] of Object.entries(step.provider.extraHeaders)) headers.set(name, value);
  return headers;
}

type FirstVerdict = "wait" | "output" | "failure";

const RESPONSES_PRELUDE = new Set(["response.created", "response.in_progress", "response.queued"]);

/**
 * Chat streams count as started with the first event. A Responses stream opens with bookkeeping
 * events (`response.created`, `response.in_progress`) that carry no output, so those do not end
 * the failover window; an upstream failure before any output does fail over.
 */
function judgeFirstEvent(api: LlmApi, event: SseEvent): FirstVerdict {
  if (api === "chat") return "output";
  const data = event.data.trim();
  if (data === "[DONE]") return "failure";
  let type = event.event;
  if (!type) {
    try {
      type = (JSON.parse(data) as { type?: string }).type;
    } catch {
      return "output";
    }
  }
  if (type && RESPONSES_PRELUDE.has(type)) return "wait";
  if (type === "response.failed" || type === "error") return "failure";
  return "output";
}

async function attemptStep(
  step: ResolvedStep,
  api: LlmApi,
  body: Record<string, unknown>,
  stream: boolean,
  clientSignal: AbortSignal,
  fetchImpl: typeof fetch,
): Promise<StepResult> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, step.timeoutMs);
  const signal = AbortSignal.any([controller.signal, clientSignal]);
  let keepAlive = false;

  try {
    const response = await fetchImpl(`${step.provider.baseUrl}${UPSTREAM_PATHS[api]}`, {
      method: "POST",
      headers: buildHeaders(step, stream),
      body: JSON.stringify(
        api === "chat"
          ? buildUpstreamBody(body, step.upstreamModel, stream)
          : buildNativeResponsesBody(body, step.upstreamModel, stream),
      ),
      signal,
    });

    if (!response.ok) {
      const text = await response.text();
      const kind = classifyStatus(response.status);
      if (kind === "failover") {
        return {
          type: "failover",
          outcome: "http_error",
          errorCode: `upstream_http_${response.status}`,
          httpStatus: response.status,
        };
      }
      return {
        type: "reject",
        httpStatus: response.status,
        mapped: mapUpstreamError(response.status, step.provider.name, extractUpstreamMessage(text)),
      };
    }

    if (!stream) {
      const text = await response.text();
      try {
        return { type: "json", text, usage: extractUsage(JSON.parse(text)) };
      } catch {
        return {
          type: "failover",
          outcome: "invalid_response",
          errorCode: "invalid_upstream_response",
        };
      }
    }

    if (!response.body) {
      return { type: "failover", outcome: "empty_stream", errorCode: "upstream_empty_stream" };
    }
    const reader = response.body.getReader();
    const parser = new SseParser();
    const decoder = new TextDecoder();
    // Wait for the first output event: the timeout covers this, and nothing is sent to the client before.
    const buffered: SseEvent[] = [];
    let verdict: FirstVerdict = "wait";
    while (verdict === "wait") {
      const { done, value } = await reader.read();
      const events = done ? parser.flush() : parser.push(decoder.decode(value, { stream: true }));
      buffered.push(...events);
      for (const event of events) {
        verdict = judgeFirstEvent(api, event);
        if (verdict !== "wait") break;
      }
      if (done) break;
    }
    if (verdict === "failure") {
      return { type: "failover", outcome: "stream_error", errorCode: "upstream_stream_error" };
    }
    if (verdict === "wait") {
      return { type: "failover", outcome: "empty_stream", errorCode: "upstream_empty_stream" };
    }
    keepAlive = true;
    return {
      type: "stream",
      reader,
      parser,
      decoder,
      firstEvents: buffered,
      abort: () => controller.abort(),
    };
  } catch {
    if (clientSignal.aborted) return { type: "client_aborted" };
    if (timedOut) return { type: "failover", outcome: "timeout", errorCode: "upstream_timeout" };
    return {
      type: "failover",
      outcome: "connection_error",
      errorCode: "upstream_connection_error",
    };
  } finally {
    clearTimeout(timer);
    // After the first output the stream runs without the connect timeout.
    if (!keepAlive && !controller.signal.aborted) controller.abort();
  }
}

function summarizeAttempts(attempts: RequestAttempt[]): string {
  return attempts
    .map((attempt) => {
      const detail = attempt.http_status
        ? `${attempt.outcome} ${attempt.http_status}`
        : attempt.outcome;
      return `${attempt.provider_name} (${detail})`;
    })
    .join(", ");
}

/**
 * Routes a request: routes with allowed MCP tools run the tool loop (always through Chat
 * Completions internally), everything else keeps the plain passthrough/failover path.
 */
export async function proxyLlmRequest(input: LlmProxyInput): Promise<Response> {
  if (input.route.mcpTools.length > 0) return proxyMcpRequest(input);
  return proxyPlainRequest(input);
}

/**
 * Sends a request through the route's steps in order with failover. Each step is called in its
 * provider's best mode: native Responses when the client speaks Responses and the provider has
 * `responses_api`, otherwise Chat Completions with translation in both directions. Streams are
 * not sent to the client until the first upstream output arrived; after that there is no failover.
 */
async function proxyPlainRequest(input: LlmProxyInput): Promise<Response> {
  const breaker = input.breaker ?? circuitBreaker;
  const fetchImpl = input.fetchImpl ?? fetch;
  const startedAt = new Date();
  const startedMs = performance.now();
  const attempts: RequestAttempt[] = [];
  const extraHeaders = input.responseHeaders ?? {};

  const finish = (
    partial: Partial<RequestOutcome> & Pick<RequestOutcome, "status" | "httpStatus">,
  ) =>
    input.onComplete({
      routeSlug: input.route.slug,
      clientApi: input.clientApi,
      stream: input.stream,
      startedAt,
      durationMs: Math.round(performance.now() - startedMs),
      attempts,
      ...partial,
    });
  const withHeaders = (headers: Record<string, string>) => ({ ...extraHeaders, ...headers });

  for (const step of input.route.steps) {
    const { provider } = step;
    const attempt: RequestAttempt = {
      provider_id: provider.id,
      provider_name: provider.name,
      model: step.upstreamModel,
      outcome: "",
      latency_ms: 0,
    };
    if (!provider.enabled) {
      attempts.push({ ...attempt, outcome: "skipped_disabled" });
      continue;
    }
    if (!breaker.tryAcquire(provider.id)) {
      attempts.push({ ...attempt, outcome: "skipped_circuit_open" });
      continue;
    }

    const upstreamApi = upstreamApiFor(input.clientApi, step);
    const stepBody = upstreamApi === input.clientApi ? input.body : input.chatBody;
    if (!stepBody) throw new Error("chatBody is required for translated steps");

    const attemptStart = performance.now();
    const result = await attemptStep(
      step,
      upstreamApi,
      stepBody,
      input.stream,
      input.clientSignal,
      fetchImpl,
    );
    attempt.latency_ms = Math.round(performance.now() - attemptStart);
    attempts.push(attempt);

    if (result.type === "client_aborted") {
      breaker.releaseTrial(provider.id);
      attempt.outcome = "client_aborted";
      finish({ status: "error", httpStatus: 499, errorCode: "client_closed" });
      return new Response(null, { status: 499, headers: extraHeaders });
    }

    if (result.type === "failover") {
      breaker.recordFailure(provider.id);
      attempt.outcome = result.outcome;
      attempt.error_code = result.errorCode;
      if (result.httpStatus) attempt.http_status = result.httpStatus;
      continue;
    }

    if (result.type === "reject") {
      breaker.releaseTrial(provider.id);
      attempt.outcome = "rejected";
      attempt.http_status = result.httpStatus;
      attempt.error_code = result.mapped.code;
      finish({
        status: "error",
        httpStatus: result.mapped.status,
        errorCode: result.mapped.code,
        errorMessage: result.mapped.message,
        providerId: provider.id,
        upstreamModel: step.upstreamModel,
        upstreamApi,
      });
      return openAIError(
        result.mapped.status,
        result.mapped.code,
        result.mapped.message,
        result.mapped.type,
        withHeaders({ "X-Gateway-Provider": provider.name }),
      );
    }

    breaker.recordSuccess(provider.id);
    attempt.outcome = "ok";
    attempt.http_status = 200;
    const answered = { providerId: provider.id, upstreamModel: step.upstreamModel, upstreamApi };

    if (result.type === "json") {
      const converted = convertJsonBody(
        input.clientApi,
        upstreamApi,
        result.text,
        input.route.slug,
        result.usage,
      );
      finish({
        status: "ok",
        httpStatus: 200,
        usage: result.usage,
        captured: converted.captured,
        ...answered,
      });
      return new Response(converted.body, {
        status: 200,
        headers: withHeaders({
          "Content-Type": "application/json",
          "X-Gateway-Provider": provider.name,
        }),
      });
    }

    const pipe = createStreamPipe(input.clientApi, upstreamApi, input.route.slug);
    return streamResponse(result, pipe, {
      provider: provider.name,
      attempt,
      breaker,
      providerId: provider.id,
      clientSignal: input.clientSignal,
      startedMs,
      extraHeaders,
      finish: (extra) => finish({ ...answered, ...extra, captured: pipe.captured() }),
    });
  }

  const summary = summarizeAttempts(attempts);
  const message = `All providers failed or were skipped: ${summary || "no steps configured"}.`;
  finish({
    status: "error",
    httpStatus: 502,
    errorCode: "all_providers_failed",
    errorMessage: message,
  });
  return openAIError(502, "all_providers_failed", message, "api_error", extraHeaders);
}

interface StreamContext {
  provider: string;
  providerId: string;
  attempt: RequestAttempt;
  breaker: CircuitBreaker;
  clientSignal: AbortSignal;
  startedMs: number;
  extraHeaders: Record<string, string>;
  finish: (extra: Partial<RequestOutcome> & Pick<RequestOutcome, "status" | "httpStatus">) => void;
}

const STREAM_LOST_MESSAGE = "The upstream provider connection was lost mid-response.";

function streamResponse(
  result: Extract<StepResult, { type: "stream" }>,
  pipe: StreamPipe,
  context: StreamContext,
): Response {
  const encoder = new TextEncoder();
  const ttftMs = Math.round(performance.now() - context.startedMs);
  let finished = false;

  const complete = (
    extra: Partial<RequestOutcome> & Pick<RequestOutcome, "status" | "httpStatus">,
  ) => {
    if (finished) return;
    finished = true;
    context.finish({ ttftMs, usage: pipe.usage, ...extra });
  };

  let framesSent = 0;
  const send = (frames: string[], controller: ReadableStreamDefaultController<Uint8Array>) => {
    for (const frame of frames) controller.enqueue(encoder.encode(frame));
    framesSent += frames.length;
  };

  const forward = (events: SseEvent[], controller: ReadableStreamDefaultController<Uint8Array>) => {
    for (const event of events) {
      if (pipe.finished) return;
      send(pipe.onEvent(event), controller);
    }
  };

  /** Records an upstream failure after output started and ends the stream with the pipe's failure frames. */
  const recordStreamFailure = (message: string) => {
    context.breaker.recordFailure(context.providerId);
    context.attempt.outcome = "stream_error";
    context.attempt.error_code = "upstream_stream_error";
    complete({
      status: "error",
      httpStatus: 200,
      errorCode: "upstream_stream_error",
      errorMessage: message,
    });
  };

  /** Ends the stream once the upstream's terminal marker was forwarded. */
  const closeIfFinished = (controller: ReadableStreamDefaultController<Uint8Array>): boolean => {
    if (!pipe.finished) return false;
    void result.reader.cancel().catch(() => {});
    controller.close();
    complete({ status: "ok", httpStatus: 200 });
    return true;
  };

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      forward(result.firstEvents, controller);
      closeIfFinished(controller);
    },
    async pull(controller) {
      if (finished) return;
      try {
        // A pull that enqueues nothing would stall the stream, so keep reading until a frame
        // went out (translated and native streams can swallow events such as `[DONE]`).
        const sentBefore = framesSent;
        while (framesSent === sentBefore) {
          const { done, value } = await result.reader.read();
          if (done) {
            forward(result.parser.flush(), controller);
            const end = pipe.finished ? { frames: [], failed: false } : pipe.onEnd();
            send(end.frames, controller);
            controller.close();
            if (end.failed) recordStreamFailure("The upstream stream ended before it completed.");
            else complete({ status: "ok", httpStatus: 200 });
            return;
          }
          forward(result.parser.push(result.decoder.decode(value, { stream: true })), controller);
          if (closeIfFinished(controller)) return;
        }
      } catch {
        if (context.clientSignal.aborted) {
          complete({ status: "error", httpStatus: 499, errorCode: "client_closed" });
          return;
        }
        send(pipe.onUpstreamError(STREAM_LOST_MESSAGE), controller);
        controller.close();
        recordStreamFailure(STREAM_LOST_MESSAGE);
      }
    },
    cancel() {
      result.abort();
      context.breaker.releaseTrial(context.providerId);
      complete({ status: "error", httpStatus: 499, errorCode: "client_closed" });
    },
  });

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      ...context.extraHeaders,
      "X-Gateway-Provider": context.provider,
    },
  });
}

// ---------------------------------------------------------------------------
// MCP tool loop (docs/mcp.md)
// ---------------------------------------------------------------------------

type ChatJson = Record<string, unknown>;

interface McpRoundOk {
  type: "ok";
  step: ResolvedStep;
  captured: CapturedResponse;
  usage?: TokenUsage;
}

type McpRoundResult =
  | McpRoundOk
  | { type: "client_aborted" }
  | {
      type: "error";
      httpStatus: 400 | 502;
      code: string;
      message: string;
      mapped?: MappedError;
      provider?: { id: string; name: string; model: string };
    };

function isChatJson(value: unknown): value is ChatJson {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toolCallIdsIn(messages: unknown[]): string[] {
  const ids = new Set<string>();
  for (const raw of messages) {
    if (!isChatJson(raw)) continue;
    if (raw.role === "tool" && typeof raw.tool_call_id === "string") ids.add(raw.tool_call_id);
  }
  return [...ids];
}

/** Puts the stored MCP assistant/tool messages back before the client's tool results. */
function injectPendingMessages(messages: unknown[], pending: unknown[]): unknown[] {
  if (pending.length === 0) return messages;
  const triggerIds = new Set(toolCallIdsIn(messages));
  const toolIndex = messages.findIndex(
    (raw) => isChatJson(raw) && raw.role === "tool" && triggerIds.has(String(raw.tool_call_id)),
  );
  if (toolIndex < 0) return [...messages, ...pending];
  let insertAt = toolIndex;
  for (let index = toolIndex; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isChatJson(message) || message.role !== "assistant") continue;
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    if (
      calls.some(
        (call) => isChatJson(call) && typeof call.id === "string" && triggerIds.has(call.id),
      )
    ) {
      insertAt = index;
      break;
    }
  }
  return [...messages.slice(0, insertAt), ...pending, ...messages.slice(insertAt)];
}

/** Merges the route's allowed MCP tools into the client's tools without duplicate names. */
export function mergeMcpTools(
  clientTools: unknown,
  mcpTools: ResolvedRoute["mcpTools"],
): unknown[] {
  const tools = Array.isArray(clientTools) ? [...clientTools] : [];
  const names = new Set<string>();
  for (const raw of tools) {
    if (!isChatJson(raw)) continue;
    const fn = isChatJson(raw.function) ? raw.function : undefined;
    const name = typeof raw.name === "string" ? raw.name : fn?.name;
    if (typeof name === "string") names.add(name);
  }
  for (const tool of mcpTools) {
    if (names.has(tool.exposedName)) continue;
    const parameters =
      isChatJson(tool.inputSchema) && Object.keys(tool.inputSchema).length > 0
        ? tool.inputSchema
        : { type: "object", properties: {} };
    tools.push({
      type: "function",
      function: {
        name: tool.exposedName,
        description: tool.description,
        parameters,
      },
    });
    names.add(tool.exposedName);
  }
  return tools;
}

function addUsage(
  total: TokenUsage | undefined,
  usage: TokenUsage | undefined,
): TokenUsage | undefined {
  if (!usage) return total;
  if (!total) return { ...usage };
  return {
    prompt_tokens: total.prompt_tokens + usage.prompt_tokens,
    completion_tokens: total.completion_tokens + usage.completion_tokens,
    total_tokens: total.total_tokens + usage.total_tokens,
  };
}

function toolErrorText(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown MCP error";
}

interface ExecutedMcpRound {
  assistantMessage: ChatJson;
  toolMessages: ChatJson[];
  items: McpTranscriptItem[];
}

/** Runs every MCP call in one model reply, recording transcript items and the messages to append. */
async function executeMcpCalls(
  calls: CapturedToolCall[],
  text: string,
  tools: ResolvedRoute["mcpTools"],
): Promise<ExecutedMcpRound> {
  const byName = new Map(tools.map((tool) => [tool.exposedName, tool]));
  const assistantCalls: unknown[] = [];
  const toolMessages: ChatJson[] = [];
  const items: McpTranscriptItem[] = [];

  for (const call of calls) {
    const tool = call.name ? byName.get(call.name) : undefined;
    const id = call.id ?? `call_${randomUUID()}`;
    const name = call.name ?? "unknown_tool";
    const args = call.args ?? {};
    const started = performance.now();
    let content = "";
    let isError = false;
    items.push({
      kind: "tool_call",
      toolCallId: id,
      toolName: name,
      toolArgs: args,
      durationMs: null,
    });
    if (!tool) {
      content = `Error: tool "${name}" is not available on this route`;
      isError = true;
    } else {
      try {
        const result = await callMcpTool(tool.server, tool.toolName, args);
        content = result.text || "(empty result)";
        isError = result.isError;
      } catch (error) {
        content = `Error: ${toolErrorText(error)}`;
        isError = true;
      }
    }
    const durationMs = Math.round(performance.now() - started);
    items.push({
      kind: "tool_result",
      toolCallId: id,
      toolName: name,
      content,
      durationMs,
      isError,
    });
    toolMessages.push({ role: "tool", tool_call_id: id, content });
    assistantCalls.push({
      id,
      type: "function",
      function: { name, arguments: call.rawArguments || JSON.stringify(args) },
    });
  }

  return {
    assistantMessage: {
      role: "assistant",
      content: text.length > 0 ? text : null,
      tool_calls: assistantCalls,
    },
    toolMessages,
    items,
  };
}

export function syntheticCompletion(
  captured: CapturedResponse,
  model: string,
  usage: TokenUsage | undefined,
): ChatJson {
  const message: ChatJson = { role: "assistant", content: captured.text || null };
  if (captured.reasoning) message.reasoning_content = captured.reasoning;
  if (captured.toolCalls.length > 0) {
    message.tool_calls = captured.toolCalls.map((call, index) => ({
      id: call.id ?? `call_${index}`,
      type: "function",
      function: { name: call.name ?? "", arguments: call.rawArguments || "{}" },
    }));
  }
  return {
    id: `chatcmpl-${randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: captured.toolCalls.length > 0 ? "tool_calls" : "stop",
      },
    ],
    ...(usage ? { usage } : {}),
  };
}

function chatChunk(
  completionId: string,
  model: string,
  delta: ChatJson,
  finish: string | null,
): string {
  return formatSse(
    JSON.stringify({
      id: completionId,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    }),
  );
}

/** SSE frames for a chat client, synthesised from the final captured reply. */
export function chatStreamFrames(
  captured: CapturedResponse,
  model: string,
  usage: TokenUsage | undefined,
): string {
  const id = `chatcmpl-${randomUUID()}`;
  const frames: string[] = [];
  const delta: ChatJson = {};
  if (captured.reasoning) delta.reasoning_content = captured.reasoning;
  if (captured.text) delta.content = captured.text;
  if (Object.keys(delta).length > 0) frames.push(chatChunk(id, model, delta, null));
  captured.toolCalls.forEach((call, index) => {
    frames.push(
      chatChunk(
        id,
        model,
        {
          tool_calls: [
            {
              index,
              id: call.id ?? `call_${index}`,
              type: "function",
              function: { name: call.name ?? "", arguments: call.rawArguments || "{}" },
            },
          ],
        },
        null,
      ),
    );
  });
  frames.push(chatChunk(id, model, {}, captured.toolCalls.length > 0 ? "tool_calls" : "stop"));
  if (usage) {
    frames.push(
      formatSse(JSON.stringify({ id, object: "chat.completion.chunk", choices: [], usage })),
    );
  }
  frames.push(formatSse(SSE_DONE));
  return frames.join("");
}

function eventFrame(event: ResponseEvent): string {
  return formatSseEvent(event.type, JSON.stringify(event.data));
}

/** SSE frames for a Responses client: translator input is the synthetic chat completion. */
export function responsesStreamFrames(
  captured: CapturedResponse,
  model: string,
  usage: TokenUsage | undefined,
): string {
  const translator = new ChatToResponsesStream(model);
  const events: ResponseEvent[] = [];
  const delta: ChatJson = {};
  if (captured.reasoning) delta.reasoning_content = captured.reasoning;
  if (captured.text) delta.content = captured.text;
  if (Object.keys(delta).length > 0) events.push(...translator.push({ choices: [{ delta }] }));
  captured.toolCalls.forEach((call, index) => {
    events.push(
      ...translator.push({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index,
                  id: call.id ?? `call_${index}`,
                  type: "function",
                  function: { name: call.name ?? "", arguments: call.rawArguments || "{}" },
                },
              ],
            },
          },
        ],
      }),
    );
  });
  if (usage) events.push(...translator.push({ choices: [], usage }));
  events.push(...translator.finish());
  return events.map(eventFrame).join("");
}

/**
 * Plain-chat MCP loop: merges allowed tools, executes MCP calls, appends their results and calls
 * upstream again (max four rounds, last with `tool_choice: "none"`). Only the final reply reaches
 * the client. Mixed replies execute the MCP calls, return only client calls and store the MCP
 * messages for re-injection on the client's next request.
 */
async function proxyMcpRequest(input: LlmProxyInput): Promise<Response> {
  const breaker = input.breaker ?? circuitBreaker;
  const fetchImpl = input.fetchImpl ?? fetch;
  const startedAt = new Date();
  const startedMs = performance.now();
  const attempts: RequestAttempt[] = [];
  const extraHeaders = input.responseHeaders ?? {};
  const mcpItems: McpTranscriptItem[] = [];

  const finish = (
    partial: Partial<RequestOutcome> & Pick<RequestOutcome, "status" | "httpStatus">,
  ) =>
    input.onComplete({
      routeSlug: input.route.slug,
      clientApi: input.clientApi,
      stream: input.stream,
      startedAt,
      durationMs: Math.round(performance.now() - startedMs),
      attempts,
      mcpItems: mcpItems.length > 0 ? mcpItems : undefined,
      ...partial,
    });

  const base = input.clientApi === "chat" ? input.body : input.chatBody;
  if (!base || !Array.isArray(base.messages)) {
    const message = "Route has MCP tools but the request has no chat messages to forward.";
    finish({
      status: "error",
      httpStatus: 500,
      errorCode: "mcp_missing_messages",
      errorMessage: message,
    });
    return openAIError(500, "mcp_missing_messages", message, "api_error", extraHeaders);
  }

  const roundChat: ChatJson = { ...base };
  delete roundChat.stream;
  delete roundChat.stream_options;
  delete roundChat.model;
  let messages = [...(roundChat.messages as unknown[])];
  if (input.sessionId) {
    const pending = await takePendingMcpMessages(input.sessionId, toolCallIdsIn(messages));
    messages = injectPendingMessages(messages, pending);
  }
  const mergedTools = mergeMcpTools(roundChat.tools, input.route.mcpTools);
  const toolByName = new Map(input.route.mcpTools.map((tool) => [tool.exposedName, tool]));

  let usageTotal: TokenUsage | undefined;

  const runRound = async (body: ChatJson): Promise<McpRoundResult> => {
    for (const step of input.route.steps) {
      const { provider } = step;
      const attempt: RequestAttempt = {
        provider_id: provider.id,
        provider_name: provider.name,
        model: step.upstreamModel,
        outcome: "",
        latency_ms: 0,
      };
      if (!provider.enabled) {
        attempts.push({ ...attempt, outcome: "skipped_disabled" });
        continue;
      }
      if (!breaker.tryAcquire(provider.id)) {
        attempts.push({ ...attempt, outcome: "skipped_circuit_open" });
        continue;
      }
      const attemptStart = performance.now();
      const result = await attemptStep(step, "chat", body, false, input.clientSignal, fetchImpl);
      attempt.latency_ms = Math.round(performance.now() - attemptStart);
      attempts.push(attempt);

      if (result.type === "client_aborted") {
        breaker.releaseTrial(provider.id);
        attempt.outcome = "client_aborted";
        return { type: "client_aborted" };
      }
      if (result.type === "failover") {
        breaker.recordFailure(provider.id);
        attempt.outcome = result.outcome;
        attempt.error_code = result.errorCode;
        if (result.httpStatus) attempt.http_status = result.httpStatus;
        continue;
      }
      if (result.type === "reject") {
        breaker.releaseTrial(provider.id);
        attempt.outcome = "rejected";
        attempt.http_status = result.httpStatus;
        attempt.error_code = result.mapped.code;
        return {
          type: "error",
          httpStatus: result.mapped.status,
          code: result.mapped.code,
          message: result.mapped.message,
          mapped: result.mapped,
          provider: { id: provider.id, name: provider.name, model: step.upstreamModel },
        };
      }
      breaker.recordSuccess(provider.id);
      attempt.outcome = "ok";
      attempt.http_status = 200;
      if (result.type === "json") {
        const capture = new ResponseCapture();
        const parsed = JSON.parse(result.text) as unknown;
        capture.captureCompletion(parsed);
        return {
          type: "ok",
          step,
          captured: capture.finish(),
          usage: result.usage,
        };
      }
      // attemptStep was called with stream=false, so a stream result cannot happen.
      breaker.recordFailure(provider.id);
      attempt.outcome = "invalid_response";
      attempt.error_code = "invalid_upstream_response";
    }
    const summary = summarizeAttempts(attempts);
    const message = `All providers failed or were skipped: ${summary || "no steps configured"}.`;
    return { type: "error", httpStatus: 502, code: "all_providers_failed", message };
  };

  const respond = (captured: CapturedResponse, step: ResolvedStep, provider: string): Response => {
    const answered = {
      providerId: step.provider.id,
      upstreamModel: step.upstreamModel,
      upstreamApi: "chat" as const,
    };
    finish({
      status: "ok",
      httpStatus: 200,
      usage: usageTotal,
      captured,
      ...answered,
    });
    if (input.clientApi === "chat" && !input.stream) {
      return new Response(
        JSON.stringify(syntheticCompletion(captured, input.route.slug, usageTotal)),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            ...extraHeaders,
            "X-Gateway-Provider": provider,
          },
        },
      );
    }
    if (input.clientApi === "chat") {
      return new Response(chatStreamFrames(captured, input.route.slug, usageTotal), {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          "X-Accel-Buffering": "no",
          ...extraHeaders,
          "X-Gateway-Provider": provider,
        },
      });
    }
    if (!input.stream) {
      const { response } = chatCompletionToResponse(
        syntheticCompletion(captured, input.route.slug, usageTotal),
        input.route.slug,
        usageTotal,
      );
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          ...extraHeaders,
          "X-Gateway-Provider": provider,
        },
      });
    }
    return new Response(responsesStreamFrames(captured, input.route.slug, usageTotal), {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
        ...extraHeaders,
        "X-Gateway-Provider": provider,
      },
    });
  };

  for (let round = 0; round < MAX_MCP_ROUNDS; round += 1) {
    const isLastRound = round === MAX_MCP_ROUNDS - 1;
    const body: ChatJson = {
      ...roundChat,
      messages,
      tools: mergedTools,
      ...(mergedTools.length > 0 ? (isLastRound ? { tool_choice: "none" } : {}) : {}),
    };
    if (mergedTools.length === 0) delete body.tool_choice;

    const result = await runRound(body);
    if (result.type === "client_aborted") {
      finish({ status: "error", httpStatus: 499, errorCode: "client_closed" });
      return new Response(null, { status: 499, headers: extraHeaders });
    }
    if (result.type === "error") {
      finish({
        status: "error",
        httpStatus: result.httpStatus,
        errorCode: result.code,
        errorMessage: result.message,
        providerId: result.provider?.id,
        upstreamModel: result.provider?.model,
        upstreamApi: result.provider ? "chat" : undefined,
      });
      if (result.mapped) {
        return openAIError(result.mapped.status, result.code, result.message, result.mapped.type, {
          ...extraHeaders,
          ...(result.provider ? { "X-Gateway-Provider": result.provider.name } : {}),
        });
      }
      return openAIError(result.httpStatus, result.code, result.message, "api_error", extraHeaders);
    }

    usageTotal = addUsage(usageTotal, result.usage);
    const captured = result.captured;
    const mcpCalls = captured.toolCalls.filter(
      (call) => call.name !== undefined && toolByName.has(call.name),
    );
    const clientCalls = captured.toolCalls.filter(
      (call) => call.name === undefined || !toolByName.has(call.name),
    );

    if (mcpCalls.length === 0) return respond(captured, result.step, result.step.provider.name);

    if (isLastRound) {
      // The provider ignored tool_choice: never expose MCP names to the client.
      const stripped: CapturedResponse = { ...captured, toolCalls: clientCalls };
      return respond(stripped, result.step, result.step.provider.name);
    }

    const executed = await executeMcpCalls(mcpCalls, captured.text, input.route.mcpTools);
    mcpItems.push(...executed.items);

    if (clientCalls.length > 0) {
      if (input.sessionId) {
        await savePendingMcpMessages(
          input.sessionId,
          clientCalls.map((call) => call.id).filter((id): id is string => !!id),
          [executed.assistantMessage, ...executed.toolMessages],
        );
      }
      const mixed: CapturedResponse = { ...captured, toolCalls: clientCalls };
      return respond(mixed, result.step, result.step.provider.name);
    }

    messages = [...messages, executed.assistantMessage, ...executed.toolMessages];
  }

  // Unreachable: the last round always answers. Kept for TypeScript.
  const message = "MCP loop ended without a reply.";
  finish({ status: "error", httpStatus: 500, errorCode: "mcp_loop_failed", errorMessage: message });
  return openAIError(500, "mcp_loop_failed", message, "api_error", extraHeaders);
}
