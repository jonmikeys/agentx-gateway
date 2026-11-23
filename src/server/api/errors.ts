import type { ContentfulStatusCode } from "hono/utils/http-status";

export interface OpenAIErrorBody {
  error: { message: string; type: string; code: string };
}

/** Builds an OpenAI-shaped error response: `{"error":{"message","type","code"}}`. */
export function openAIError(
  status: ContentfulStatusCode,
  code: string,
  message: string,
  type = "invalid_request_error",
  headers?: HeadersInit,
): Response {
  const body: OpenAIErrorBody = { error: { message, type, code } };
  return Response.json(body, { status, headers });
}
