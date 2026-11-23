import type { Context, Hono } from "hono";
import { type ClientToolDefinition, normalizeClientTools } from "@/lib/agents/client-tools";
import { chatCompletionRequestSchema, responsesRequestSchema } from "@/lib/gateway-schemas";
import { type RunAgentResult, runAgent } from "@/server/agents/runtime";
import { openAIError } from "@/server/api/errors";
import type { LlmApi, TokenUsage } from "@/server/db/schema";
import { type ClientEnv, recordTokenUsage } from "@/server/gateway/client-auth";
import {
  proxyLlmRequest,
  type RequestOutcome,
  syntheticCompletion,
  upstreamApiFor,
} from "@/server/gateway/llm-proxy";
import {
  buildChatRequest,
  type ChatMessage,
  convertTools,
  normalizeResponsesInput,
  TranslationError,
} from "@/server/gateway/responses/request-translate";
import { chatCompletionToResponse } from "@/server/gateway/responses/response-translate";
import { ChatToResponsesStream } from "@/server/gateway/responses/stream-translate";
import { formatSse, formatSseEvent, SSE_DONE } from "@/server/gateway/sse";
import { contentToText } from "@/server/gateway/transcript/diff";
import type {
  CapturedResponse,
  CapturedToolCall,
} from "@/server/gateway/transcript/response-capture";
import { logger } from "@/server/logger";
import {
  listPublishedAgents,
  type ResolvedAgent,
  resolveAgentRestrictions,
  resolvePublishedAgent,
} from "@/server/services/agents";
import { recordLlmRequest } from "@/server/services/llm-requests";
import {
  listEnabledRoutes,
  type ResolvedRoute,
  resolveRoute,
  selectRoute,
} from "@/server/services/routes";
import { recordRunLog } from "@/server/services/run-logs";
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

/** `agent_id` wins; a `agent:<id>` model is the equivalent Unity can send in the model field. */
export function requestedAgentId(data: Record<string, unknown>): string | undefined {
  const explicit = data.agent_id;
  if (typeof explicit === "string" && explicit.trim()) return explicit.trim();
  const model = data.model;
  if (typeof model === "string" && model.startsWith("agent:")) {
    const id = model.slice("agent:".length).trim();
    return id || undefined;
  }
  return undefined;
}

/** What a request needs after validation: the bodies and the chat view of the messages. */
interface PreparedRequest {
  body: Record<string, unknown>;
  chatBody?: Record<string, unknown>;
  /** Messages in chat format, used for transcript capture. */
  messages: unknown[];
  stream: boolean;
  /** Function tools the Unity client sent (offered by agent LLM nodes that select them). */
  clientTools: ClientToolDefinition[];
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

/** The route used by `inherit` LLM nodes: agent default, then the request model, then the default route. */
async function resolveAgentRoute(
  agent: ResolvedAgent,
  body: Record<string, unknown>,
): Promise<ResolvedRoute | undefined> {
  const preferred = agent.flow.settings.default_route_slug;
  if (preferred) {
    const route = await resolveRoute({ kind: "slug", slug: preferred });
    if (route) return route;
  }
  const model = typeof body.model === "string" ? body.model.trim() : "";
  if (model && model !== "default" && !model.startsWith("agent:")) {
    const route = await resolveRoute({ kind: "slug", slug: model });
    if (route) return route;
  }
  return resolveRoute({ kind: "default" });
}

function lastUserText(messages: unknown[]): string {
  for (const message of [...messages].reverse()) {
    if (typeof message !== "object" || message === null) continue;
    const entry = message as { role?: unknown; content?: unknown };
    if (entry.role !== "user") continue;
    return contentToText(entry.content);
  }
  return "";
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
  // an unknown/expired/ended id is 404 session_not_found.
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
    sessionId: session.sessionId,
    onComplete,
  });
}

/** Persists an agent turn as a normal transcript row plus its run log (linked by turn id). */
async function persistAgentRun(input: {
  clientApi: LlmApi;
  prepared: PreparedRequest;
  apiKeyId: string;
  sessionId: string;
  routeSlug: string;
  startedAt: Date;
  durationMs: number;
  result: RunAgentResult;
}): Promise<void> {
  const captured: CapturedResponse = {
    text: input.result.reply,
    reasoning: input.result.reasoning,
    toolCalls: input.result.toolCalls ?? [],
  };
  const outcome: RequestOutcome = {
    routeSlug: input.routeSlug,
    clientApi: input.clientApi,
    upstreamApi: "chat",
    stream: input.prepared.stream,
    status: input.result.status === "error" ? "error" : "ok",
    httpStatus: input.result.status === "error" ? 502 : 200,
    errorCode: input.result.status === "error" ? "agent_run_failed" : undefined,
    errorMessage: input.result.error,
    startedAt: input.startedAt,
    durationMs: input.durationMs,
    attempts: [],
    usage: input.result.usage,
    captured,
  };
  try {
    const persisted = await persistRequest({
      sessionId: input.sessionId,
      apiKeyId: input.apiKeyId,
      messages: input.prepared.messages,
      outcome,
    });
    await recordRunLog({
      sessionId: input.sessionId,
      turnId: persisted?.turnId ?? null,
      flowId: input.result.trace.flow_id,
      version: input.result.trace.version,
      trace: input.result.trace,
      status: input.result.status === "error" ? "error" : "ok",
      startedAt: input.startedAt,
      durationMs: input.durationMs,
    });
  } catch (error) {
    logger.error("Failed to store agent run", {
      error: error instanceof Error ? error.message : "unknown error",
      session_id: input.sessionId,
    });
    await recordLlmRequest(input.apiKeyId, outcome);
  }
}

function chatDeltaFrame(id: string, model: string, content: string): string {
  return formatSse(
    JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta: { content }, finish_reason: null }],
    }),
  );
}

function chatToolCallFrame(
  id: string,
  model: string,
  call: CapturedToolCall,
  index: number,
): string {
  return formatSse(
    JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index,
                id: call.id ?? `call_${index}`,
                type: "function",
                function: { name: call.name ?? "", arguments: call.rawArguments || "{}" },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    }),
  );
}

function chatUsableUsage(usage: TokenUsage | undefined): string {
  if (!usage) return "";
  return formatSse(
    JSON.stringify({
      id: `chatcmpl-agent`,
      object: "chat.completion.chunk",
      choices: [],
      usage,
    }),
  );
}

/** A request that names an agent (`agent_id` or `model: agent:<id>`) runs the published graph. */
async function runAgentRequest(
  c: ClientContext,
  clientApi: LlmApi,
  prepared: PreparedRequest,
  agentId: string,
): Promise<Response> {
  const agent = await resolvePublishedAgent(agentId);
  if (!agent) {
    return openAIError(
      400,
      "invalid_agent",
      `The agent "${agentId}" does not exist, is disabled or has no published version.`,
    );
  }
  const apiKey = c.get("apiKey");
  const route = await resolveAgentRoute(agent, prepared.body);
  const routeSlug = route?.slug ?? "agent";
  const restrictions = await resolveAgentRestrictions(agent.flow.settings);

  // The existing hook ends a session that started with another agent (or none) and starts a new one.
  const session = await resolveSession({
    headerValue: c.req.header(SESSION_HEADER),
    apiKeyId: apiKey.id,
    routeSlug,
    agentId: agent.flow.id,
  });
  if (!session) {
    return openAIError(404, "session_not_found", "Session is unknown or expired.");
  }

  const headers: Record<string, string> = { [SESSION_HEADER]: session.sessionId };
  const modelLabel = `agent:${agent.flow.id}`;
  const inputText = lastUserText(prepared.messages);
  const startedAt = new Date();
  const startedMs = performance.now();

  if (!prepared.stream) {
    const result = await runAgent({
      flowId: agent.flow.id,
      version: agent.version,
      graph: agent.graph,
      pinnedSubflows: agent.pinnedSubflows,
      sessionId: session.sessionId,
      messages: prepared.messages,
      inputText,
      route,
      signal: c.req.raw.signal,
      clientTools: prepared.clientTools,
      clientRestrictions: restrictions,
    });
    await persistAgentRun({
      clientApi,
      prepared,
      apiKeyId: apiKey.id,
      sessionId: session.sessionId,
      routeSlug,
      startedAt,
      durationMs: result.trace.duration_ms,
      result,
    });
    await recordTokenUsage(apiKey, result.usage?.total_tokens ?? 0);
    if (result.status === "error" && !result.reply) {
      return openAIError(
        502,
        "agent_run_failed",
        result.error ?? "The agent run failed.",
        "api_error",
        headers,
      );
    }
    const usage = result.usage;
    const captured: CapturedResponse = {
      text: result.reply,
      reasoning: result.reasoning,
      toolCalls: result.toolCalls ?? [],
    };
    if (clientApi === "chat") {
      return new Response(JSON.stringify(syntheticCompletion(captured, modelLabel, usage)), {
        status: 200,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }
    const { response } = chatCompletionToResponse(
      syntheticCompletion(captured, modelLabel, usage),
      modelLabel,
      usage,
    );
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { ...headers, "Content-Type": "application/json" },
    });
  }

  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const write = (frame: string) => {
    if (frame) void writer.write(encoder.encode(frame));
  };
  const completionId = `chatcmpl-${agent.flow.id}`;
  const translator = clientApi === "responses" ? new ChatToResponsesStream(modelLabel) : undefined;
  let closed = false;

  const finish = async (result: RunAgentResult) => {
    if (closed) return;
    closed = true;
    if (clientApi === "chat") {
      if (result.status === "error" && !result.reply) {
        write(
          formatSse(
            JSON.stringify({
              error: {
                message: result.error ?? "The agent run failed.",
                type: "api_error",
                code: "agent_run_failed",
              },
            }),
          ),
        );
      }
      const pausedCalls = result.status === "paused" ? (result.toolCalls ?? []) : [];
      pausedCalls.forEach((call, index) => {
        write(chatToolCallFrame(completionId, modelLabel, call, index));
      });
      write(
        formatSse(
          JSON.stringify({
            id: completionId,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: modelLabel,
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: pausedCalls.length > 0 ? "tool_calls" : "stop",
              },
            ],
          }),
        ),
      );
      write(chatUsableUsage(result.usage));
      write(formatSse(SSE_DONE));
    } else if (translator) {
      if (result.status === "error" && !result.reply) {
        for (const event of translator.fail(
          "agent_run_failed",
          result.error ?? "The agent run failed.",
        )) {
          write(formatSseEvent(event.type, JSON.stringify(event.data)));
        }
      } else {
        if (result.status === "paused") {
          (result.toolCalls ?? []).forEach((call, index) => {
            for (const event of translator?.push({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index,
                        id: call.id ?? `call_${index}`,
                        type: "function",
                        function: { name: call.name ?? "", arguments: call.rawArguments || "{}" },
                      },
                    ],
                  },
                },
              ],
            }) ?? []) {
              write(formatSseEvent(event.type, JSON.stringify(event.data)));
            }
          });
        }
        if (result.usage) {
          for (const event of translator.push({ choices: [], usage: result.usage })) {
            write(formatSseEvent(event.type, JSON.stringify(event.data)));
          }
        }
        for (const event of translator.finish()) {
          write(formatSseEvent(event.type, JSON.stringify(event.data)));
        }
      }
    }
    await writer.close().catch(() => {});
    void persistAgentRun({
      clientApi,
      prepared,
      apiKeyId: apiKey.id,
      sessionId: session.sessionId,
      routeSlug,
      startedAt,
      durationMs: result.trace.duration_ms,
      result,
    })
      .then(() => recordTokenUsage(apiKey, result.usage?.total_tokens ?? 0))
      .catch((error: unknown) =>
        logger.error("Failed to record agent run", {
          error: error instanceof Error ? error.message : "unknown error",
          route: routeSlug,
        }),
      );
    logger.info("agent run", {
      flow: agent.flow.id,
      version: agent.version,
      status: result.status,
      duration_ms: Math.round(performance.now() - startedMs),
      steps: result.trace.steps.length,
    });
  };

  void runAgent({
    flowId: agent.flow.id,
    version: agent.version,
    graph: agent.graph,
    pinnedSubflows: agent.pinnedSubflows,
    sessionId: session.sessionId,
    messages: prepared.messages,
    inputText,
    route,
    signal: c.req.raw.signal,
    clientTools: prepared.clientTools,
    clientRestrictions: restrictions,
    onEvent: (event) => {
      if (event.type !== "text" || !event.delta) return;
      if (translator) {
        for (const translated of translator.push({
          choices: [{ delta: { content: event.delta } }],
        })) {
          write(formatSseEvent(translated.type, JSON.stringify(translated.data)));
        }
        return;
      }
      write(chatDeltaFrame(completionId, modelLabel, event.delta));
    },
  })
    .then(finish)
    .catch((error: unknown) => {
      if (!closed) {
        closed = true;
        write(
          formatSse(
            JSON.stringify({
              error: {
                message: error instanceof Error ? error.message : "The agent run failed.",
                type: "api_error",
                code: "agent_run_failed",
              },
            }),
          ),
        );
        write(formatSse(SSE_DONE));
        void writer.close().catch(() => {});
      }
    });

  return new Response(readable, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      "X-Agent-Id": agent.flow.id,
      "X-Agent-Version": String(agent.version),
      ...headers,
    },
  });
}

/** Registers the authenticated client routes (`/v1/agents`, `/agents`, `/v1/models`, chat, responses). */
export function registerClientRoutes(app: Hono<ClientEnv>): void {
  const listAgents = async (c: ClientContext) => {
    const agents = await listPublishedAgents();
    return c.json({
      object: "list",
      data: agents.map((agent) => ({
        id: agent.id,
        object: "agent",
        name: agent.name,
        description: agent.description,
        created: Math.floor(agent.createdAt.getTime() / 1000),
      })),
    });
  };
  app.get("/v1/agents", listAgents);
  app.get("/agents", listAgents);

  app.get("/v1/models", async (c) => {
    const [routes, agents] = await Promise.all([listEnabledRoutes(), listPublishedAgents()]);
    return c.json({
      object: "list",
      data: [
        ...routes.map((route) => ({
          id: route.slug,
          object: "model",
          created: Math.floor(route.createdAt.getTime() / 1000),
          owned_by: "agentx-gateway",
        })),
        ...agents.map((agent) => ({
          id: `agent:${agent.id}`,
          object: "model",
          created: Math.floor(agent.createdAt.getTime() / 1000),
          owned_by: "agentx-gateway",
        })),
      ],
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

    const raw = parsed.data as Record<string, unknown>;
    const agentId = requestedAgentId(raw);
    const body = stripGatewayFields(raw);
    const prepared: PreparedRequest = {
      body,
      messages: parsed.data.messages,
      stream: parsed.data.stream === true,
      clientTools: normalizeClientTools(raw.tools),
    };
    if (agentId) return runAgentRequest(c, "chat", prepared, agentId);

    const resolved = await resolveRequestedRoute(body);
    if ("error" in resolved) return resolved.error;
    return runRequest(c, "chat", resolved.route, prepared);
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

    const raw = parsed.data as Record<string, unknown>;
    const agentId = requestedAgentId(raw);
    const body = stripGatewayFields(raw);
    if (body.previous_response_id !== undefined && body.previous_response_id !== null) {
      return openAIError(
        400,
        "unsupported_parameter",
        "previous_response_id is not supported: the gateway is stateless for Responses, so the client must send the full conversation in input on every request.",
      );
    }

    let messages: ChatMessage[];
    let chatBody: Record<string, unknown> | undefined;
    try {
      messages = normalizeResponsesInput(body);
    } catch (error) {
      if (error instanceof TranslationError) {
        return openAIError(400, error.code, error.message);
      }
      throw error;
    }

    if (agentId) {
      let clientTools: ClientToolDefinition[] = [];
      try {
        clientTools = normalizeClientTools(convertTools(body.tools) ?? []);
      } catch (error) {
        if (error instanceof TranslationError) {
          return openAIError(400, error.code, error.message);
        }
        throw error;
      }
      return runAgentRequest(
        c,
        "responses",
        { body, messages, stream: parsed.data.stream === true, clientTools },
        agentId,
      );
    }

    const resolved = await resolveRequestedRoute(body);
    if ("error" in resolved) return resolved.error;
    const { route } = resolved;

    try {
      // MCP routes always call Chat Completions internally; other routes only translate when a
      // step is not a native Responses provider. This also rejects what chat cannot express.
      const needsTranslation =
        route.mcpTools.length > 0 ||
        route.steps.some((step) => upstreamApiFor("responses", step) === "chat");
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
      clientTools: [],
    });
  });
}
