import type { Hono } from "hono";
import { chatCompletionRequestSchema } from "@/lib/gateway-schemas";
import { openAIError } from "@/server/api/errors";
import { proxyChatCompletion, type RequestOutcome } from "@/server/gateway/chat-proxy";
import { type ClientEnv, recordTokenUsage } from "@/server/gateway/client-auth";
import { logger } from "@/server/logger";
import { recordLlmRequest } from "@/server/services/llm-requests";
import { listEnabledRoutes, resolveRoute, selectRoute } from "@/server/services/routes";

/** Fields consumed by the gateway that must never reach the upstream provider. */
const GATEWAY_ONLY_FIELDS = ["agent_id"];

/** Registers the authenticated client routes (`/v1/models`, `/v1/chat/completions`). */
export function registerClientRoutes(app: Hono<ClientEnv>): void {
  app.get("/v1/models", async (c) => {
    const routes = await listEnabledRoutes();
    return c.json({
      object: "list",
      data: routes.map((route) => ({
        id: route.slug,
        object: "model",
        created: Math.floor(route.createdAt.getTime() / 1000),
        owned_by: "agentx-gateway",
      })),
    });
  });

  app.post("/v1/chat/completions", async (c) => {
    let json: unknown;
    try {
      json = await c.req.json();
    } catch {
      return openAIError(400, "invalid_json", "Request body must be valid JSON.");
    }
    const parsed = chatCompletionRequestSchema.safeParse(json);
    if (!parsed.success) {
      return openAIError(
        400,
        "invalid_request",
        parsed.error.issues[0]?.message ?? "Invalid request body.",
      );
    }

    const body: Record<string, unknown> = { ...parsed.data };
    for (const field of GATEWAY_ONLY_FIELDS) delete body[field];

    const route = await resolveRoute(selectRoute(body.model));
    if (!route) {
      const requested =
        typeof body.model === "string" && body.model.trim() ? body.model : "default";
      return openAIError(
        400,
        "model_not_found",
        `The model "${requested}" does not exist or is disabled.`,
      );
    }

    const apiKey = c.get("apiKey");
    const onComplete = (outcome: RequestOutcome) => {
      recordLlmRequest(apiKey.id, outcome)
        .then(() => recordTokenUsage(apiKey, outcome.usage?.total_tokens ?? 0))
        .catch((error: unknown) =>
          logger.error("Failed to record request", {
            error: error instanceof Error ? error.message : "unknown error",
            route: outcome.routeSlug,
          }),
        );
      logger.info("chat completion", {
        route: outcome.routeSlug,
        status: outcome.status,
        http_status: outcome.httpStatus,
        error_code: outcome.errorCode,
        duration_ms: outcome.durationMs,
        ttft_ms: outcome.ttftMs,
        attempts: outcome.attempts.length,
      });
    };

    return proxyChatCompletion({
      body,
      stream: parsed.data.stream === true,
      route,
      clientSignal: c.req.raw.signal,
      onComplete,
    });
  });
}
