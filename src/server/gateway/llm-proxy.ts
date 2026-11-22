import { openAIError } from "@/server/api/errors";
import type { LlmApi, RequestAttempt, TokenUsage } from "@/server/db/schema";
import { type CircuitBreaker, circuitBreaker } from "@/server/gateway/circuit-breaker";
import { type SseEvent, SseParser } from "@/server/gateway/sse";
import { convertJsonBody, createStreamPipe, type StreamPipe } from "@/server/gateway/stream-pipes";
import type { CapturedResponse } from "@/server/gateway/transcript/response-capture";
import {
  classifyStatus,
  extractUpstreamMessage,
  type MappedError,
  mapUpstreamError,
} from "@/server/gateway/upstream-errors";
import { extractUsage } from "@/server/gateway/usage";
import type { ResolvedRoute, ResolvedStep } from "@/server/services/routes";

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
 * Sends a request through the route's steps in order with failover. Each step is called in its
 * provider's best mode: native Responses when the client speaks Responses and the provider has
 * `responses_api`, otherwise Chat Completions with translation in both directions. Streams are
 * not sent to the client until the first upstream output arrived; after that there is no failover.
 */
export async function proxyLlmRequest(input: LlmProxyInput): Promise<Response> {
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
