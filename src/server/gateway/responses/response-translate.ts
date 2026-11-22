import type { TokenUsage } from "@/server/db/schema";
import {
  buildResponseObject,
  incompleteReason,
  type Json,
  newId,
  outputItemsFromCaptured,
} from "@/server/gateway/responses/response-objects";
import {
  type CapturedResponse,
  ResponseCapture,
} from "@/server/gateway/transcript/response-capture";

export interface TranslatedCompletion {
  response: Json;
  captured: CapturedResponse;
}

function finishReasonOf(completion: unknown): unknown {
  const choices = (completion as { choices?: unknown })?.choices;
  if (!Array.isArray(choices)) return undefined;
  return (choices[0] as { finish_reason?: unknown } | undefined)?.finish_reason;
}

/** Chat completion JSON -> Responses object (`model` is the route slug). */
export function chatCompletionToResponse(
  completion: unknown,
  model: string,
  usage: TokenUsage | undefined,
): TranslatedCompletion {
  const capture = new ResponseCapture();
  capture.captureCompletion(completion);
  const captured = capture.finish();
  const reason = incompleteReason(finishReasonOf(completion));
  const response = buildResponseObject({
    id: newId("resp"),
    createdAt: Math.floor(Date.now() / 1000),
    model,
    status: reason ? "incomplete" : "completed",
    output: outputItemsFromCaptured(captured),
    usage,
    incomplete: reason,
  });
  return { response, captured };
}
