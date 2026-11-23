import type { LlmApi, TokenUsage } from "@/server/db/schema";
import { buildResponseObject, type Json, newId } from "@/server/gateway/responses/response-objects";
import { chatCompletionToResponse } from "@/server/gateway/responses/response-translate";
import {
  ChatToResponsesStream,
  type ResponseEvent,
} from "@/server/gateway/responses/stream-translate";
import { formatSse, formatSseEvent, SSE_DONE, type SseEvent } from "@/server/gateway/sse";
import {
  type CapturedResponse,
  type OutputCapture,
  ResponseCapture,
} from "@/server/gateway/transcript/response-capture";
import { ResponsesCapture } from "@/server/gateway/transcript/responses-capture";
import { extractUsage } from "@/server/gateway/usage";

/**
 * Per-request adapters between the upstream stream and what the client receives. A pipe turns
 * each upstream SSE event into zero or more ready-to-send SSE frames, observes it for transcript
 * capture and usage, and knows how to end the stream when the upstream breaks.
 */
export interface StreamPipe {
  onEvent(event: SseEvent): string[];
  /** The upstream closed the connection; `failed` when that was before a terminal event. */
  onEnd(): { frames: string[]; failed: boolean };
  /** The upstream connection broke after output started. */
  onUpstreamError(message: string): string[];
  /** The upstream sent its terminal marker; nothing else should be read. */
  readonly finished: boolean;
  readonly usage: TokenUsage | undefined;
  captured(): CapturedResponse;
}

/** Result of converting one complete upstream JSON body for the client. */
export interface JsonPipeResult {
  body: string;
  captured: CapturedResponse;
}

const UPSTREAM_STREAM_ERROR = "upstream_stream_error";

function parseJson(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return undefined;
  }
}

function eventFrame(event: ResponseEvent): string {
  return formatSseEvent(event.type, JSON.stringify(event.data));
}

/** Chat -> chat: forward the chunks as-is, observe them, end with `[DONE]`. */
class ChatPassthroughPipe implements StreamPipe {
  private readonly capture = new ResponseCapture();
  private done = false;
  private usageValue: TokenUsage | undefined;

  get finished(): boolean {
    return this.done;
  }

  get usage(): TokenUsage | undefined {
    return this.usageValue;
  }

  onEvent(event: SseEvent): string[] {
    if (this.done) return [];
    const data = event.data.trim();
    if (data === SSE_DONE) {
      this.done = true;
      return [formatSse(SSE_DONE)];
    }
    if (data.includes('"usage"')) {
      this.usageValue = extractUsage(parseJson(data)) ?? this.usageValue;
    }
    // Observe after building the frame so capture never delays the client.
    const frame = formatSse(event.data);
    this.capture.pushEvent(data);
    return [frame];
  }

  onEnd(): { frames: string[]; failed: boolean } {
    return { frames: this.done ? [] : [formatSse(SSE_DONE)], failed: false };
  }

  onUpstreamError(message: string): string[] {
    const error = { error: { message, type: "api_error", code: UPSTREAM_STREAM_ERROR } };
    return [formatSse(JSON.stringify(error)), formatSse(SSE_DONE)];
  }

  captured(): CapturedResponse {
    return this.capture.finish();
  }
}

const TERMINAL_TYPES = new Set(["response.completed", "response.incomplete", "response.failed"]);

/** Responses -> Responses: forward events untouched (minus `[DONE]`), observe them. */
class ResponsesPassthroughPipe implements StreamPipe {
  private readonly capture = new ResponsesCapture();
  private done = false;
  private usageValue: TokenUsage | undefined;
  private responseId: string | undefined;
  private sequence = -1;

  get finished(): boolean {
    return this.done;
  }

  get usage(): TokenUsage | undefined {
    return this.usageValue;
  }

  onEvent(event: SseEvent): string[] {
    if (this.done) return [];
    const data = event.data.trim();
    // Responses streams have no [DONE] sentinel and clients parse every data line as JSON.
    if (data === SSE_DONE) return [];
    const parsed = parseJson(data) as Json | undefined;
    const type = event.event || (typeof parsed?.type === "string" ? parsed.type : undefined);
    if (typeof parsed?.sequence_number === "number") this.sequence = parsed.sequence_number;
    const response = parsed?.response as Json | undefined;
    if (typeof response?.id === "string") this.responseId = response.id;
    if (type === "response.completed" || type === "response.incomplete") {
      this.usageValue = extractUsage(response) ?? this.usageValue;
    }
    if (type && TERMINAL_TYPES.has(type)) this.done = true;

    const frame = type ? formatSseEvent(type, event.data) : formatSse(event.data);
    this.capture.pushEvent(data, type);
    return [frame];
  }

  onEnd(): { frames: string[]; failed: boolean } {
    if (this.done) return { frames: [], failed: false };
    const message = "The upstream provider closed the stream before the response completed.";
    return { frames: this.failedFrames(message), failed: true };
  }

  onUpstreamError(message: string): string[] {
    return this.failedFrames(message);
  }

  captured(): CapturedResponse {
    return this.capture.finish();
  }

  private failedFrames(message: string): string[] {
    this.done = true;
    const event: ResponseEvent = {
      type: "response.failed",
      data: {
        type: "response.failed",
        sequence_number: this.sequence + 1,
        response: buildResponseObject({
          id: this.responseId ?? newId("resp"),
          createdAt: Math.floor(Date.now() / 1000),
          model: "",
          status: "failed",
          output: [],
          error: { code: UPSTREAM_STREAM_ERROR, message },
        }),
      },
    };
    return [eventFrame(event)];
  }
}

/** Responses client, chat upstream: translate each chat chunk into Responses events. */
class TranslatingPipe implements StreamPipe {
  private readonly capture = new ResponseCapture();
  private readonly translator: ChatToResponsesStream;

  constructor(routeSlug: string) {
    this.translator = new ChatToResponsesStream(routeSlug);
  }

  get finished(): boolean {
    return this.translator.isTerminated;
  }

  get usage(): TokenUsage | undefined {
    return this.translator.usage;
  }

  onEvent(event: SseEvent): string[] {
    if (this.translator.isTerminated) return [];
    const data = event.data.trim();
    if (data === SSE_DONE) return this.translator.finish().map(eventFrame);
    const parsed = parseJson(data);
    if (parsed === undefined) return [];
    const frames = this.translator.push(parsed).map(eventFrame);
    this.capture.pushEvent(data);
    return frames;
  }

  onEnd(): { frames: string[]; failed: boolean } {
    return { frames: this.translator.finish().map(eventFrame), failed: false };
  }

  onUpstreamError(message: string): string[] {
    return this.translator.fail(UPSTREAM_STREAM_ERROR, message).map(eventFrame);
  }

  captured(): CapturedResponse {
    return this.capture.finish();
  }
}

export function createStreamPipe(
  clientApi: LlmApi,
  upstreamApi: LlmApi,
  routeSlug: string,
): StreamPipe {
  if (clientApi === "chat") return new ChatPassthroughPipe();
  return upstreamApi === "responses"
    ? new ResponsesPassthroughPipe()
    : new TranslatingPipe(routeSlug);
}

/** Converts a complete upstream JSON body for the client and captures what the model produced. */
export function convertJsonBody(
  clientApi: LlmApi,
  upstreamApi: LlmApi,
  text: string,
  routeSlug: string,
  usage: TokenUsage | undefined,
): JsonPipeResult {
  const parsed = parseJson(text);
  if (clientApi === "responses" && upstreamApi === "chat") {
    const { response, captured } = chatCompletionToResponse(parsed, routeSlug, usage);
    return { body: JSON.stringify(response), captured };
  }
  const capture: OutputCapture =
    upstreamApi === "responses" ? new ResponsesCapture() : new ResponseCapture();
  capture.captureCompletion(parsed);
  return { body: text, captured: capture.finish() };
}
