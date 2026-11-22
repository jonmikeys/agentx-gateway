import { openAIError } from "@/server/api/errors";
import type { RequestAttempt, TokenUsage } from "@/server/db/schema";
import { type CircuitBreaker, circuitBreaker } from "@/server/gateway/circuit-breaker";
import { formatSse, SSE_DONE, type SseEvent, SseParser } from "@/server/gateway/sse";
import {
  classifyStatus,
  extractUpstreamMessage,
  type MappedError,
  mapUpstreamError,
} from "@/server/gateway/upstream-errors";
import type { ResolvedRoute, ResolvedStep } from "@/server/services/routes";

/** Everything the caller needs to persist one `llm_requests` row. Contains no message content. */
export interface RequestOutcome {
  routeSlug: string;
  providerId?: string;
  upstreamModel?: string;
  stream: boolean;
  status: "ok" | "error";
  httpStatus: number;
  errorCode?: string;
  startedAt: Date;
  durationMs: number;
  ttftMs?: number;
  attempts: RequestAttempt[];
  usage?: TokenUsage;
}

export interface ChatProxyInput {
  /** Request body with gateway-only fields already stripped. */
  body: Record<string, unknown>;
  stream: boolean;
  route: ResolvedRoute;
  clientSignal: AbortSignal;
  onComplete: (outcome: RequestOutcome) => void;
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

export function extractUsage(value: unknown): TokenUsage | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = (value as { usage?: unknown }).usage;
  if (typeof raw !== "object" || raw === null) return undefined;
  const usage = raw as Record<string, unknown>;
  const prompt = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0) || 0;
  const completion = Number(usage.completion_tokens ?? usage.output_tokens ?? 0) || 0;
  const total = Number(usage.total_tokens ?? prompt + completion) || prompt + completion;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total };
}

/** Builds the upstream request body: model rewritten, usage reporting requested for streams. */
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

function buildHeaders(step: ResolvedStep, stream: boolean): Headers {
  const headers = new Headers({
    "Content-Type": "application/json",
    Accept: stream ? "text/event-stream" : "application/json",
  });
  if (step.provider.apiKey) headers.set("Authorization", `Bearer ${step.provider.apiKey}`);
  for (const [name, value] of Object.entries(step.provider.extraHeaders)) headers.set(name, value);
  return headers;
}

async function attemptStep(
  step: ResolvedStep,
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
    const response = await fetchImpl(`${step.provider.baseUrl}/chat/completions`, {
      method: "POST",
      headers: buildHeaders(step, stream),
      body: JSON.stringify(buildUpstreamBody(body, step.upstreamModel, stream)),
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
    // Wait for the first SSE data event: the timeout covers this, and nothing is sent to the client before.
    let firstEvents: SseEvent[] = [];
    while (firstEvents.length === 0) {
      const { done, value } = await reader.read();
      if (done) {
        firstEvents = parser.flush();
        break;
      }
      firstEvents = parser.push(decoder.decode(value, { stream: true }));
    }
    if (firstEvents.length === 0) {
      return { type: "failover", outcome: "empty_stream", errorCode: "upstream_empty_stream" };
    }
    keepAlive = true;
    return {
      type: "stream",
      reader,
      parser,
      decoder,
      firstEvents,
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
    // After the first chunk the stream runs without the connect timeout.
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
 * Sends a chat completion through the route's steps in order with failover. Streams are not
 * sent to the client until the first upstream data chunk arrived; after that there is no failover.
 */
export async function proxyChatCompletion(input: ChatProxyInput): Promise<Response> {
  const breaker = input.breaker ?? circuitBreaker;
  const fetchImpl = input.fetchImpl ?? fetch;
  const startedAt = new Date();
  const startedMs = performance.now();
  const attempts: RequestAttempt[] = [];

  const finish = (
    partial: Partial<RequestOutcome> & Pick<RequestOutcome, "status" | "httpStatus">,
  ) =>
    input.onComplete({
      routeSlug: input.route.slug,
      stream: input.stream,
      startedAt,
      durationMs: Math.round(performance.now() - startedMs),
      attempts,
      ...partial,
    });

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
    const result = await attemptStep(step, input.body, input.stream, input.clientSignal, fetchImpl);
    attempt.latency_ms = Math.round(performance.now() - attemptStart);
    attempts.push(attempt);

    if (result.type === "client_aborted") {
      breaker.releaseTrial(provider.id);
      attempt.outcome = "client_aborted";
      finish({ status: "error", httpStatus: 499, errorCode: "client_closed" });
      return new Response(null, { status: 499 });
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
        providerId: provider.id,
        upstreamModel: step.upstreamModel,
      });
      return openAIError(
        result.mapped.status,
        result.mapped.code,
        result.mapped.message,
        result.mapped.type,
        {
          "X-Gateway-Provider": provider.name,
        },
      );
    }

    breaker.recordSuccess(provider.id);
    attempt.outcome = "ok";
    attempt.http_status = 200;
    const answered = { providerId: provider.id, upstreamModel: step.upstreamModel };

    if (result.type === "json") {
      finish({ status: "ok", httpStatus: 200, usage: result.usage, ...answered });
      return new Response(result.text, {
        status: 200,
        headers: { "Content-Type": "application/json", "X-Gateway-Provider": provider.name },
      });
    }

    return streamResponse(result, {
      provider: provider.name,
      attempt,
      breaker,
      providerId: provider.id,
      clientSignal: input.clientSignal,
      startedMs,
      finish: (extra) => finish({ ...answered, ...extra }),
    });
  }

  const summary = summarizeAttempts(attempts);
  finish({ status: "error", httpStatus: 502, errorCode: "all_providers_failed" });
  return openAIError(
    502,
    "all_providers_failed",
    `All providers failed or were skipped: ${summary || "no steps configured"}.`,
    "api_error",
  );
}

interface StreamContext {
  provider: string;
  providerId: string;
  attempt: RequestAttempt;
  breaker: CircuitBreaker;
  clientSignal: AbortSignal;
  startedMs: number;
  finish: (extra: Partial<RequestOutcome> & Pick<RequestOutcome, "status" | "httpStatus">) => void;
}

function streamResponse(
  result: Extract<StepResult, { type: "stream" }>,
  context: StreamContext,
): Response {
  const encoder = new TextEncoder();
  const ttftMs = Math.round(performance.now() - context.startedMs);
  let usage: TokenUsage | undefined;
  let sawDone = false;
  let finished = false;

  const complete = (
    extra: Partial<RequestOutcome> & Pick<RequestOutcome, "status" | "httpStatus">,
  ) => {
    if (finished) return;
    finished = true;
    context.finish({ ttftMs, usage, ...extra });
  };

  const forward = (events: SseEvent[], controller: ReadableStreamDefaultController<Uint8Array>) => {
    for (const event of events) {
      if (sawDone) return;
      const data = event.data.trim();
      if (data === SSE_DONE) {
        sawDone = true;
        controller.enqueue(encoder.encode(formatSse(SSE_DONE)));
        return;
      }
      if (data.includes('"usage"')) {
        try {
          usage = extractUsage(JSON.parse(data)) ?? usage;
        } catch {
          // Not JSON; forward as-is.
        }
      }
      controller.enqueue(encoder.encode(formatSse(event.data)));
    }
  };

  const failStream = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    context.breaker.recordFailure(context.providerId);
    context.attempt.outcome = "stream_error";
    context.attempt.error_code = "upstream_stream_error";
    const error = {
      error: {
        message: "The upstream provider connection was lost mid-response.",
        type: "api_error",
        code: "upstream_stream_error",
      },
    };
    controller.enqueue(encoder.encode(formatSse(JSON.stringify(error))));
    controller.enqueue(encoder.encode(formatSse(SSE_DONE)));
    controller.close();
    complete({ status: "error", httpStatus: 200, errorCode: "upstream_stream_error" });
  };

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      forward(result.firstEvents, controller);
      if (sawDone) {
        // Upstream sent [DONE] immediately; nothing else will follow.
        void result.reader.cancel().catch(() => {});
        controller.close();
        complete({ status: "ok", httpStatus: 200 });
      }
    },
    async pull(controller) {
      if (finished) return;
      try {
        const { done, value } = await result.reader.read();
        if (done) {
          forward(result.parser.flush(), controller);
          if (!sawDone) controller.enqueue(encoder.encode(formatSse(SSE_DONE)));
          controller.close();
          complete({ status: "ok", httpStatus: 200 });
          return;
        }
        forward(result.parser.push(result.decoder.decode(value, { stream: true })), controller);
        if (sawDone) {
          void result.reader.cancel().catch(() => {});
          controller.close();
          complete({ status: "ok", httpStatus: 200 });
        }
      } catch {
        if (context.clientSignal.aborted) {
          complete({ status: "error", httpStatus: 499, errorCode: "client_closed" });
          return;
        }
        failStream(controller);
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
      "X-Gateway-Provider": context.provider,
    },
  });
}
