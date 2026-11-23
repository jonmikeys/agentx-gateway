import { getDb } from "@/server/db/client";
import { llmRequests } from "@/server/db/schema";
import type { RequestOutcome } from "@/server/gateway/chat-proxy";

/** Minimal executor shared by the pool and a transaction. */
type Executor = Pick<ReturnType<typeof getDb>, "insert">;

export interface RequestLink {
  sessionId: string;
  turnId: string;
}

/** Persists one request row (IDs, timings, codes, token counts; never message content). */
export async function recordLlmRequest(
  apiKeyId: string | null,
  outcome: RequestOutcome,
  link?: RequestLink,
  executor: Executor = getDb(),
): Promise<string> {
  const [row] = await executor
    .insert(llmRequests)
    .values({
      apiKeyId,
      sessionId: link?.sessionId ?? null,
      turnId: link?.turnId ?? null,
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
    })
    .returning({ id: llmRequests.id });
  return row.id;
}
