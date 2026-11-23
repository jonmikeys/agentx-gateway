import type { TokenUsage } from "@/server/db/schema";
import { type CircuitBreaker, circuitBreaker } from "@/server/gateway/circuit-breaker";
import { SSE_DONE, type SseEvent, SseParser } from "@/server/gateway/sse";
import {
  type CapturedResponse,
  ResponseCapture,
} from "@/server/gateway/transcript/response-capture";
import { ThinkTagSplitter } from "@/server/gateway/transcript/think-splitter";
import { classifyStatus, extractUpstreamMessage } from "@/server/gateway/upstream-errors";
import { extractUsage } from "@/server/gateway/usage";
import type { ResolvedRoute, ResolvedStep } from "@/server/services/routes";

/** A node failure with a stable code; `retryable` only matters while no output reached the client. */
export class AgentRuntimeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = true,
  ) {
    super(message);
    this.name = "AgentRuntimeError";
  }
}

export interface ChatDelta {
  text?: string;
  reasoning?: string;
}

export interface ChatOptions {
  route: ResolvedRoute;
  messages: unknown[];
  tools?: unknown[];
  toolChoice?: "auto" | "none" | "required";
  stream: boolean;
  signal: AbortSignal;
  onDelta?: (delta: ChatDelta) => void;
  fetchImpl?: typeof fetch;
  breaker?: CircuitBreaker;
}

export interface ChatResult {
  text: string;
  reasoning: string;
  toolCalls: CapturedResponse["toolCalls"];
  usage?: TokenUsage;
}

function upstreamHeaders(step: ResolvedStep, stream: boolean): Headers {
  const headers = new Headers({
    "Content-Type": "application/json",
    Accept: stream ? "text/event-stream" : "application/json",
  });
  if (step.provider.apiKey) headers.set("Authorization", `Bearer ${step.provider.apiKey}`);
  for (const [name, value] of Object.entries(step.provider.extraHeaders)) headers.set(name, value);
  return headers;
}

function requestBody(options: ChatOptions, step: ResolvedStep): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: step.upstreamModel,
    messages: options.messages,
  };
  if (options.tools && options.tools.length > 0) {
    body.tools = options.tools;
    if (options.toolChoice) body.tool_choice = options.toolChoice;
  }
  if (options.stream) {
    body.stream = true;
    body.stream_options = { include_usage: true };
  }
  return body;
}

function combineSignals(signals: AbortSignal[]): AbortSignal {
  return AbortSignal.any(signals);
}

interface StepCallState {
  emitted: boolean;
}

async function callStep(
  options: ChatOptions,
  step: ResolvedStep,
  fetchImpl: typeof fetch,
  state: StepCallState,
): Promise<ChatResult> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, step.timeoutMs);
  const signal = combineSignals([controller.signal, options.signal]);

  try {
    const response = await fetchImpl(`${step.provider.baseUrl}/chat/completions`, {
      method: "POST",
      headers: upstreamHeaders(step, options.stream),
      body: JSON.stringify(requestBody(options, step)),
      signal,
    });

    if (!response.ok) {
      const text = await response.text();
      const kind = classifyStatus(response.status);
      if (kind === "failover") {
        throw new AgentRuntimeError(
          `upstream_http_${response.status}`,
          `Provider "${step.provider.name}" is unavailable (HTTP ${response.status}).`,
        );
      }
      throw new AgentRuntimeError(
        "upstream_rejected",
        extractUpstreamMessage(text) ?? `Provider "${step.provider.name}" rejected the request.`,
        false,
      );
    }

    if (!options.stream) {
      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new AgentRuntimeError("invalid_upstream_response", "Upstream returned invalid JSON.");
      }
      const capture = new ResponseCapture();
      capture.captureCompletion(parsed);
      const captured = capture.finish();
      return {
        text: captured.text,
        reasoning: captured.reasoning,
        toolCalls: captured.toolCalls,
        usage: extractUsage(parsed),
      };
    }

    if (!response.body) {
      throw new AgentRuntimeError("upstream_empty_stream", "Upstream returned an empty stream.");
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parser = new SseParser();
    const capture = new ResponseCapture();
    const splitter = new ThinkTagSplitter();
    let usage: TokenUsage | undefined;
    let done = false;

    const observe = (event: SseEvent) => {
      const data = event.data.trim();
      if (data === SSE_DONE) {
        done = true;
        return;
      }
      if (!data) return;
      let chunk: unknown;
      try {
        chunk = JSON.parse(data);
      } catch {
        return;
      }
      usage = extractUsage(chunk) ?? usage;
      capture.pushEvent(data);
      const delta = (chunk as { choices?: { delta?: Record<string, unknown> }[] }).choices?.[0]
        ?.delta;
      if (!delta) return;
      if (typeof delta.reasoning_content === "string" && options.onDelta) {
        options.onDelta({ reasoning: delta.reasoning_content });
      }
      if (typeof delta.reasoning === "string" && options.onDelta) {
        options.onDelta({ reasoning: delta.reasoning });
      }
      if (typeof delta.content === "string") {
        const split = splitter.push(delta.content);
        if (split.reasoning && options.onDelta) options.onDelta({ reasoning: split.reasoning });
        if (split.text) {
          state.emitted = true;
          options.onDelta?.({ text: split.text });
        }
      }
    };

    while (!done) {
      const { done: end, value } = await reader.read();
      const events = end ? parser.flush() : parser.push(decoder.decode(value, { stream: true }));
      for (const event of events) observe(event);
      if (end) break;
    }
    const flush = splitter.flush();
    if (flush.reasoning && options.onDelta) options.onDelta({ reasoning: flush.reasoning });
    if (flush.text) {
      state.emitted = true;
      options.onDelta?.({ text: flush.text });
    }
    const captured = capture.finish();
    return {
      text: captured.text,
      reasoning: captured.reasoning,
      toolCalls: captured.toolCalls,
      usage,
    };
  } catch (error) {
    if (options.signal.aborted) {
      throw new AgentRuntimeError("client_closed", "The client closed the connection.", false);
    }
    if (error instanceof AgentRuntimeError) {
      throw new AgentRuntimeError(error.code, error.message, error.retryable && !state.emitted);
    }
    if (timedOut) {
      throw new AgentRuntimeError("upstream_timeout", "The provider timed out.", !state.emitted);
    }
    throw new AgentRuntimeError(
      "upstream_connection_error",
      error instanceof Error ? error.message : "The provider connection failed.",
      !state.emitted,
    );
  } finally {
    clearTimeout(timer);
    if (!state.emitted) controller.abort();
  }
}

/**
 * Calls a model route through its ordered steps with failover. Streams deltas to `onDelta`; a
 * failure before the first delta fails over, afterwards it is final.
 */
export async function chatThroughRoute(options: ChatOptions): Promise<ChatResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const breaker = options.breaker ?? circuitBreaker;
  const failures: string[] = [];
  const state: StepCallState = { emitted: false };

  for (const step of options.route.steps) {
    if (!step.provider.enabled) {
      failures.push(`${step.provider.name} (disabled)`);
      continue;
    }
    if (!breaker.tryAcquire(step.provider.id)) {
      failures.push(`${step.provider.name} (circuit open)`);
      continue;
    }
    try {
      const result = await callStep(options, step, fetchImpl, state);
      breaker.recordSuccess(step.provider.id);
      return result;
    } catch (error) {
      breaker.releaseTrial(step.provider.id);
      if (!(error instanceof AgentRuntimeError)) throw error;
      if (!error.retryable) {
        breaker.recordFailure(step.provider.id);
        throw error;
      }
      breaker.recordFailure(step.provider.id);
      failures.push(`${step.provider.name} (${error.code})`);
    }
  }
  throw new AgentRuntimeError(
    "all_providers_failed",
    `Every provider failed: ${failures.join(", ") || "no steps configured"}.`,
  );
}
