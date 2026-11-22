import type { Context, Hono } from "hono";
import { chatCompletionRequestSchema, responsesRequestSchema } from "@/lib/gateway-schemas";
import { openAIError } from "@/server/api/errors";
import type { LlmApi } from "@/server/db/schema";
import { type ClientEnv, recordTokenUsage } from "@/server/gateway/client-auth";
import { proxyLlmRequest, type RequestOutcome, upstreamApiFor } from "@/server/gateway/llm-proxy";
import {
  buildChatRequest,
  type ChatMessage,
  normalizeResponsesInput,
  TranslationError,
} from "@/server/gateway/responses/request-translate";
import { logger } from "@/server/logger";
import { recordLlmRequest } from "@/server/services/llm-requests";
import {
  listEnabledRoutes,
  type ResolvedRoute,
  resolveRoute,
  selectRoute,
} from "@/server/services/routes";
import { persistRequest, resolveSession, SESSION_HEADER } from "@/server/services/sessions";

/** Fields consumed by the gateway that must never reach the upstream provider. */
const GATEWAY_ONLY_FIELDS = ["agent_id"];

type ClientContext = Context<ClientEnv>;

async function readJson(c: ClientContext): Promise<{ json: unknown } | { error: Response }> {
  try {
    return { json: await c.req.json() };
  } catch {
    return { error: openAIError(400, "invalid_json", "Request body must be valid JSON.") };
  }
}

function stripGatewayFields(data: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = { ...data };
  for (const field of GATEWAY_ONLY_FIELDS) delete body[field];
  return body;
}

/** What a request needs after validation: the bodies and the chat view of the messages. */
interface PreparedRequest {
  body: Record<string, unknown>;
  chatBody?: Record<string, unknown>;
  /** Messages in chat format, used for transcript capture. */
  messages: unknown[];
  stream: boolean;
}

async function resolveRequestedRoute(
  body: Record<string, unknown>,
): Promise<{ route: ResolvedRoute } | { error: Response }> {
  const route = await resolveRoute(selectRoute(body.model));
  if (route) return { route };
  const requested = typeof body.model === "string" && body.model.trim() ? body.model : "default";
  return {
    error: openAIError(
      400,
      "model_not_found",
      `The model "${requested}" does not exist or is disabled.`,
    ),
  };
}

/**
 * Session handling, proxying, transcript persistence and request logging shared by
 * `/v1/chat/completions` and `/v1/responses`.
 */
async function runRequest(
  c: ClientContext,
  clientApi: LlmApi,
  route: ResolvedRoute,
  prepared: PreparedRequest,
): Promise<Response> {
  const apiKey = c.get("apiKey");

  // Session contract (Unity protocol): no header starts a session, a header continues it,
  // an unknown/expired/ended id is 404 session_not_found. `agent_id` is wired in G7a.
  const session = await resolveSession({
    headerValue: c.req.header(SESSION_HEADER),
    apiKeyId: apiKey.id,
    routeSlug: route.slug,
    agentId: null,
  });
  if (!session) {
    return openAIError(404, "session_not_found", "Session is unknown or expired.");
  }

  const persist = async (outcome: RequestOutcome) => {
    try {
      await persistRequest({
        sessionId: session.sessionId,
        apiKeyId: apiKey.id,
        messages: prepared.messages,
        outcome,
      });
    } catch (error) {
      logger.error("Failed to store transcript", {
        error: error instanceof Error ? error.message : "unknown error",
        session_id: session.sessionId,
      });
      // The session may have been deleted mid-request; still keep the request log.
      await recordLlmRequest(apiKey.id, outcome);
    }
  };

  const onComplete = (outcome: RequestOutcome) => {
    persist(outcome)
      .then(() => recordTokenUsage(apiKey, outcome.usage?.total_tokens ?? 0))
      .catch((error: unknown) =>
        logger.error("Failed to record request", {
          error: error instanceof Error ? error.message : "unknown error",
          route: outcome.routeSlug,
        }),
      );
    logger.info(clientApi === "chat" ? "chat completion" : "response", {
      route: outcome.routeSlug,
      client_api: outcome.clientApi,
      upstream_api: outcome.upstreamApi,
      status: outcome.status,
      http_status: outcome.httpStatus,
      error_code: outcome.errorCode,
      duration_ms: outcome.durationMs,
      ttft_ms: outcome.ttftMs,
      attempts: outcome.attempts.length,
    });
  };

  return proxyLlmRequest({
    clientApi,
    body: prepared.body,
    chatBody: prepared.chatBody,
    stream: prepared.stream,
    route,
    clientSignal: c.req.raw.signal,
    responseHeaders: { [SESSION_HEADER]: session.sessionId },
    onComplete,
  });
}

/** Registers the authenticated client routes (`/v1/models`, `/v1/chat/completions`, `/v1/responses`). */
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
    const read = await readJson(c);
    if ("error" in read) return read.error;
    const parsed = chatCompletionRequestSchema.safeParse(read.json);
    if (!parsed.success) {
      return openAIError(
        400,
        "invalid_request",
        parsed.error.issues[0]?.message ?? "Invalid request body.",
      );
    }

    const body = stripGatewayFields(parsed.data);
    const resolved = await resolveRequestedRoute(body);
    if ("error" in resolved) return resolved.error;

    return runRequest(c, "chat", resolved.route, {
      body,
      messages: parsed.data.messages,
      stream: parsed.data.stream === true,
    });
  });

  app.post("/v1/responses", async (c) => {
    const read = await readJson(c);
    if ("error" in read) return read.error;
    const parsed = responsesRequestSchema.safeParse(read.json);
    if (!parsed.success) {
      return openAIError(
        400,
        "invalid_request",
        parsed.error.issues[0]?.message ?? "Invalid request body.",
      );
    }

    const body = stripGatewayFields(parsed.data);
    if (body.previous_response_id !== undefined && body.previous_response_id !== null) {
      return openAIError(
        400,
        "unsupported_parameter",
        "previous_response_id is not supported: the gateway is stateless for Responses, so the client must send the full conversation in input on every request.",
      );
    }

    const resolved = await resolveRequestedRoute(body);
    if ("error" in resolved) return resolved.error;
    const { route } = resolved;

    let messages: ChatMessage[];
    let chatBody: Record<string, unknown> | undefined;
    try {
      messages = normalizeResponsesInput(body);
      // Only routes with a translated step need a chat request; this also rejects what chat cannot express.
      const needsTranslation = route.steps.some(
        (step) => upstreamApiFor("responses", step) === "chat",
      );
      if (needsTranslation) chatBody = buildChatRequest(body, messages);
    } catch (error) {
      if (error instanceof TranslationError) {
        return openAIError(400, error.code, error.message);
      }
      throw error;
    }

    return runRequest(c, "responses", route, {
      body,
      chatBody,
      messages,
      stream: parsed.data.stream === true,
    });
  });
}
