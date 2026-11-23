import type { TokenUsage } from "@/server/db/schema";

/** Reads `usage` from a chat chunk/completion or a Responses object (both token field names). */
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
