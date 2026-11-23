import { getDb } from "@/server/db/client";
import { llmRequests } from "@/server/db/schema";
import type { RequestOutcome } from "@/server/gateway/chat-proxy";

/** Persists one request row (IDs, timings, codes, token counts; never message content). */
export async function recordLlmRequest(
  apiKeyId: string | null,
  outcome: RequestOutcome,
): Promise<void> {
  await getDb()
    .insert(llmRequests)
    .values({
      apiKeyId,
      routeSlug: outcome.routeSlug,
      providerId: outcome.providerId ?? null,
      upstreamModel: outcome.upstreamModel ?? null,
      stream: outcome.stream,
      status: outcome.status,
      httpStatus: outcome.httpStatus,
      errorCode: outcome.errorCode ?? null,
      startedAt: outcome.startedAt,
      durationMs: outcome.durationMs,
      ttftMs: outcome.ttftMs ?? null,
      attempts: outcome.attempts,
      usage: outcome.usage ?? null,
    });
}
