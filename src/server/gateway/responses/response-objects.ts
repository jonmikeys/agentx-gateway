import { randomBytes } from "node:crypto";
import type { TokenUsage } from "@/server/db/schema";
import type { CapturedResponse } from "@/server/gateway/transcript/response-capture";

export type Json = Record<string, unknown>;

/** Opaque, unique-enough ids shaped like OpenAI's (`resp_...`, `msg_...`, `fc_...`, `rs_...`). */
export function newId(prefix: "resp" | "msg" | "fc" | "rs" | "call"): string {
  return `${prefix}_${randomBytes(12).toString("hex")}`;
}

export type ResponseStatus = "in_progress" | "completed" | "incomplete" | "failed";

/** Why a response is `incomplete`, using the Responses API reason names. */
export type IncompleteReason = "max_output_tokens" | "content_filter";

export function incompleteReason(finishReason: unknown): IncompleteReason | undefined {
  if (finishReason === "length") return "max_output_tokens";
  if (finishReason === "content_filter") return "content_filter";
  return undefined;
}

export function toResponsesUsage(usage: TokenUsage | undefined): Json | null {
  if (!usage) return null;
  return {
    input_tokens: usage.prompt_tokens,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: usage.completion_tokens,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: usage.total_tokens,
  };
}

export function reasoningItem(id: string, text: string, status: "in_progress" | "completed"): Json {
  return {
    id,
    type: "reasoning",
    status,
    summary: text ? [{ type: "summary_text", text }] : [],
  };
}

export function outputTextPart(text: string): Json {
  return { type: "output_text", text, annotations: [], logprobs: [] };
}

export function messageItem(id: string, text: string, status: "in_progress" | "completed"): Json {
  return {
    id,
    type: "message",
    status,
    role: "assistant",
    content: status === "completed" ? [outputTextPart(text)] : [],
  };
}

export function functionCallItem(
  id: string,
  callId: string,
  name: string,
  args: string,
  status: "in_progress" | "completed",
): Json {
  return { id, type: "function_call", status, call_id: callId, name, arguments: args };
}

export interface ResponseObjectInit {
  id: string;
  createdAt: number;
  model: string;
  status: ResponseStatus;
  output: Json[];
  usage?: TokenUsage;
  incomplete?: IncompleteReason;
  error?: { code: string; message: string };
}

export function buildResponseObject(init: ResponseObjectInit): Json {
  return {
    id: init.id,
    object: "response",
    created_at: init.createdAt,
    status: init.status,
    error: init.error ?? null,
    incomplete_details: init.incomplete ? { reason: init.incomplete } : null,
    model: init.model,
    output: init.output,
    parallel_tool_calls: true,
    store: false,
    usage: toResponsesUsage(init.usage),
  };
}

/** Output items for a complete reply: optional reasoning, the message, then function calls. */
export function outputItemsFromCaptured(captured: CapturedResponse): Json[] {
  const output: Json[] = [];
  if (captured.reasoning) {
    output.push(reasoningItem(newId("rs"), captured.reasoning, "completed"));
  }
  if (captured.text) output.push(messageItem(newId("msg"), captured.text, "completed"));
  for (const call of captured.toolCalls) {
    output.push(
      functionCallItem(
        newId("fc"),
        call.id ?? newId("call"),
        call.name ?? "",
        call.rawArguments || "{}",
        "completed",
      ),
    );
  }
  return output;
}
