import { z } from "zod";
import { chatCompletionRequestSchema, responsesRequestSchema } from "@/lib/gateway-schemas";

/**
 * OpenAPI 3.1 document for the client API, served at `GET /v1/openapi.json` and rendered by the
 * Scalar reference at `/docs`. Request bodies reuse the runtime Zod schemas (extended with the
 * documented pass-through fields); responses are described by the Zod schemas below. Every route
 * registered on the client Hono app must appear here: `tests/unit/openapi.test.ts` enforces it.
 */

type JsonObject = Record<string, unknown>;

export const OPENAPI_PATH = "/v1/openapi.json";

// ---------------------------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------------------------

const errorSchema = z
  .object({
    error: z.object({
      message: z.string().describe("Human-readable description. Never contains transcript text."),
      type: z
        .string()
        .describe(
          "OpenAI error type: invalid_request_error, authentication_error, permission_error, rate_limit_error, api_error or server_error.",
        ),
      code: z.string().describe("Stable machine-readable code, for example session_not_found."),
    }),
  })
  .describe("OpenAI-shaped error body.");

const healthSchema = z.object({
  ok: z.boolean().describe("true when the gateway and its database are healthy."),
  db: z.boolean().describe("Database reachability."),
  version: z.string().describe("Gateway version (package.json)."),
});

const modelSchema = z.object({
  id: z
    .string()
    .describe("A model route slug, or `agent:<id>` for a published agent. Send it as `model`."),
  object: z.literal("model"),
  created: z.number().int().describe("Unix seconds."),
  owned_by: z.literal("agentx-gateway"),
});

const agentSchema = z.object({
  id: z.string().describe("Agent id (`agt_…`). Send it as `agent_id`."),
  object: z.literal("agent"),
  name: z.string(),
  description: z.string(),
  created: z.number().int().describe("Unix seconds."),
});

const mediaSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  kind: z.enum(["image", "video"]),
  tags: z.array(z.string()),
  content_url: z
    .string()
    .describe(
      "Absolute URL of the file: `/v1/media/{id}/content` for uploads, or the external URL as stored.",
    ),
  mime_type: z.string(),
});

const cameraSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  type: z.string().describe("Stream type, for example `mjpeg`."),
  url: z.string().optional().describe("Stream URL, when configured."),
  credentials: z
    .object({ username: z.string(), password: z.string() })
    .optional()
    .describe("Stream credentials, when configured (decrypted for the authenticated client)."),
});

const listOf = (item: z.ZodType) => z.object({ object: z.literal("list"), data: z.array(item) });

const chatMessageSchema = z.looseObject({
  role: z.enum(["system", "developer", "user", "assistant", "tool"]),
  content: z.union([z.string(), z.array(z.looseObject({ type: z.string() })), z.null()]).optional(),
  name: z.string().optional(),
  tool_calls: z.array(z.unknown()).optional().describe("Assistant tool calls (OpenAI shape)."),
  tool_call_id: z.string().optional().describe("For `role: tool` results."),
});

const agentIdField = z
  .string()
  .optional()
  .describe(
    "Gateway extension: run this published agent instead of a model route (equivalent to `model: agent:<id>`). Unknown or disabled agents are `400 invalid_agent`. Never forwarded upstream.",
  );

const modelField = z
  .string()
  .optional()
  .describe(
    "A model route slug from `GET /v1/models`, `agent:<id>`, or omitted for the default route.",
  );

const chatRequestDocSchema = chatCompletionRequestSchema
  .extend({
    model: modelField,
    messages: z
      .array(chatMessageSchema)
      .min(1)
      .describe("The full conversation history (the client sends it on every request)."),
    stream: z
      .boolean()
      .optional()
      .describe(
        "Stream Server-Sent Events. `stream_options.include_usage` is requested upstream automatically.",
      ),
    agent_id: agentIdField,
    tools: z.array(z.unknown()).optional().describe("Function tools (OpenAI shape)."),
    tool_choice: z.unknown().optional(),
    temperature: z.number().optional(),
    reasoning_effort: z.string().optional(),
    thinking: z.unknown().optional(),
  })
  .describe(
    "OpenAI Chat Completions request. Only `messages` is validated; unknown fields pass through to the upstream provider.",
  )
  .meta({
    examples: [
      {
        model: "avatar-default",
        stream: true,
        messages: [
          { role: "system", content: "You are Aiko, a friendly lobby greeter." },
          { role: "user", content: "Hi! What can you show me?" },
        ],
      },
    ],
  });

const responsesRequestDocSchema = responsesRequestSchema
  .extend({
    model: modelField,
    input: z
      .union([z.string().min(1), z.array(z.unknown()).min(1)])
      .describe("A string or the full list of input items (the gateway is stateless)."),
    stream: z.boolean().optional().describe("Stream Responses Server-Sent Events."),
    previous_response_id: z
      .null()
      .optional()
      .describe("Not supported (`400 unsupported_parameter`): send the full conversation."),
    agent_id: agentIdField,
    instructions: z.string().optional(),
    tools: z.array(z.unknown()).optional(),
    store: z.boolean().optional().describe("Ignored."),
  })
  .describe(
    "OpenAI Responses request. Native passthrough for `responses_api` providers, otherwise translated to Chat Completions.",
  )
  .meta({
    examples: [
      {
        model: "avatar-default",
        stream: true,
        instructions: "You are Aiko, a friendly lobby greeter.",
        input: [{ role: "user", content: "Hi! What can you show me?" }],
      },
    ],
  });

const chatCompletionSchema = z
  .looseObject({
    id: z.string(),
    object: z.literal("chat.completion"),
    created: z.number().int(),
    model: z.string(),
    choices: z.array(
      z.looseObject({
        index: z.number().int(),
        message: chatMessageSchema,
        finish_reason: z.string().nullable(),
      }),
    ),
    usage: z
      .looseObject({
        prompt_tokens: z.number().int(),
        completion_tokens: z.number().int(),
        total_tokens: z.number().int(),
      })
      .optional(),
  })
  .describe("OpenAI chat completion (upstream body, or synthesised for agents).");

const responseObjectSchema = z
  .looseObject({
    id: z.string(),
    object: z.literal("response"),
    created_at: z.number().int(),
    status: z.string(),
    model: z.string(),
    output: z.array(z.unknown()),
    usage: z.unknown().optional(),
  })
  .describe("OpenAI Responses object.");

const SCHEMAS: Record<string, z.ZodType> = {
  Error: errorSchema,
  Health: healthSchema,
  Model: modelSchema,
  ModelList: listOf(modelSchema),
  Agent: agentSchema,
  AgentList: listOf(agentSchema),
  MediaItem: mediaSchema,
  MediaList: listOf(mediaSchema),
  Camera: cameraSchema,
  CameraList: listOf(cameraSchema),
  ChatMessage: chatMessageSchema,
  ChatCompletionRequest: chatRequestDocSchema,
  ChatCompletion: chatCompletionSchema,
  ResponsesRequest: responsesRequestDocSchema,
  Response: responseObjectSchema,
};

function toSchema(schema: z.ZodType): JsonObject {
  const json = z.toJSONSchema(schema, {
    target: "draft-2020-12",
    io: "input",
    unrepresentable: "any",
    // `z.int()` emits the safe-integer bounds, which reference UIs show as example values.
    override: ({ jsonSchema }) => {
      if (jsonSchema.minimum === Number.MIN_SAFE_INTEGER) delete jsonSchema.minimum;
      if (jsonSchema.maximum === Number.MAX_SAFE_INTEGER) delete jsonSchema.maximum;
    },
  }) as JsonObject;
  delete json.$schema;
  return json;
}

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

interface ErrorCode {
  code: string;
  type: string;
  message: string;
}

const err = (code: string, message: string, type = "invalid_request_error"): ErrorCode => ({
  code,
  type,
  message,
});

/** Every documented error code, with an example message. */
export const DOCUMENTED_ERRORS = {
  invalidJson: err("invalid_json", "Request body must be valid JSON."),
  invalidRequest: err("invalid_request", "messages must be a non-empty array"),
  invalidAgent: err(
    "invalid_agent",
    'The agent "agt_unknown" does not exist, is disabled or has no published version.',
  ),
  modelNotFound: err("model_not_found", 'The model "gpt-x" does not exist or is disabled.'),
  upstreamBadRequest: err("upstream_bad_request", "The upstream provider rejected the request."),
  unsupportedParameter: err(
    "unsupported_parameter",
    "previous_response_id is not supported: the gateway is stateless for Responses.",
  ),
  invalidApiKey: err(
    "invalid_api_key",
    "Invalid or missing API key. Send 'Authorization: Bearer <key>'.",
    "authentication_error",
  ),
  ipNotAllowed: err(
    "ip_not_allowed",
    "This API key may not be used from your IP address.",
    "permission_error",
  ),
  sessionNotFound: err("session_not_found", "Session is unknown or expired."),
  mediaNotFound: err("media_not_found", "No media item 3f2a9c1e."),
  rateLimit: err(
    "rate_limit_exceeded",
    "Rate limit of 60 requests per minute exceeded.",
    "rate_limit_error",
  ),
  internal: err("internal_error", "Internal server error", "server_error"),
  mcpLoopFailed: err("mcp_loop_failed", "The MCP tool loop failed.", "api_error"),
  allProvidersFailed: err(
    "all_providers_failed",
    "All providers for route avatar-default failed.",
    "api_error",
  ),
  upstreamAuthFailed: err(
    "upstream_auth_failed",
    'Upstream provider "openai" rejected the gateway\'s credentials (HTTP 401).',
    "api_error",
  ),
  upstreamNotFound: err(
    "upstream_not_found",
    'Upstream provider "openai" could not find the endpoint or model (HTTP 404).',
    "api_error",
  ),
  upstreamError: err(
    "upstream_error",
    'Upstream provider "openai" returned HTTP 418.',
    "api_error",
  ),
  agentRunFailed: err("agent_run_failed", "The agent run failed.", "api_error"),
} satisfies Record<string, ErrorCode>;

const E = DOCUMENTED_ERRORS;

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (name: string) => ({ "application/json": { schema: ref(name) } });

const SESSION_HEADER_DOC = {
  description:
    "Session id. Returned on every chat/responses reply; send it back to continue the session.",
  schema: { type: "string" },
};

const RETRY_AFTER_DOC = {
  "Retry-After": { description: "Seconds until the limit resets.", schema: { type: "integer" } },
};

function errorResponse(description: string, codes: ErrorCode[], headers?: JsonObject): JsonObject {
  const examples = Object.fromEntries(
    codes.map((entry) => [
      entry.code,
      {
        summary: entry.code,
        value: { error: { message: entry.message, type: entry.type, code: entry.code } },
      },
    ]),
  );
  return {
    description: `${description} Codes: ${codes.map((entry) => `\`${entry.code}\``).join(", ")}.`,
    ...(headers ? { headers } : {}),
    content: { "application/json": { schema: ref("Error"), examples } },
  };
}

const AUTH_ERRORS: JsonObject = {
  "401": errorResponse("Missing, unknown or revoked API key.", [E.invalidApiKey]),
  "403": errorResponse("The API key's IP allowlist rejects the caller.", [E.ipNotAllowed]),
  "429": errorResponse(
    "The API key exceeded its requests/minute or tokens/day limit.",
    [E.rateLimit],
    RETRY_AFTER_DOC,
  ),
};

function llmResponses(okSchema: string, streamDescription: string, badRequest: ErrorCode[]) {
  return {
    "200": {
      description:
        "Completed reply (`stream: false`), or a Server-Sent Events stream (`stream: true`). Failover happens only before the first streamed token; a later upstream failure ends the stream with an error event (`upstream_stream_error`).",
      headers: { "X-Session-Id": SESSION_HEADER_DOC },
      content: {
        ...json(okSchema),
        "text/event-stream": { schema: { type: "string", description: streamDescription } },
      },
    },
    "400": errorResponse("Invalid request.", badRequest),
    ...AUTH_ERRORS,
    "404": errorResponse(
      "The `X-Session-Id` is unknown, expired or ended. On chat routes 404 is reserved for this code: start a new session by omitting the header.",
      [E.sessionNotFound],
    ),
    "500": errorResponse("Gateway error.", [E.internal, E.mcpLoopFailed]),
    "502": errorResponse(
      "Upstream failure after failover, or an upstream error that is not forwarded as-is (upstream 401/403/404 are mapped so they never look like session expiry).",
      [
        E.allProvidersFailed,
        E.upstreamAuthFailed,
        E.upstreamNotFound,
        E.upstreamError,
        E.agentRunFailed,
      ],
      { "X-Session-Id": SESSION_HEADER_DOC },
    ),
  };
}

function catalogueGet(summary: string, description: string, schema: string, tag: string) {
  return {
    get: {
      tags: [tag],
      summary,
      description,
      responses: { "200": { description: "OK", content: json(schema) }, ...AUTH_ERRORS },
    },
  };
}

const binary = { "application/octet-stream": { schema: { type: "string", format: "binary" } } };

// ---------------------------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------------------------

function buildPaths(): JsonObject {
  const sessionParam = {
    name: "X-Session-Id",
    in: "header",
    required: false,
    description:
      "Continue an existing session. Omit it to start a new one; the reply's `X-Session-Id` header carries the id. A request that names a different agent than the session's ends that session and returns a new id.",
    schema: { type: "string" },
  };

  const agentsDescription =
    "Published, enabled agents. Subflows are never listed. `GET /agents` is an alias.";

  return {
    "/health": {
      get: {
        tags: ["Health"],
        summary: "Health check",
        description: "Unauthenticated liveness and database check.",
        security: [],
        responses: {
          "200": { description: "Healthy.", content: json("Health") },
          "503": { description: "The database is unreachable.", content: json("Health") },
        },
      },
    },
    "/v1/openapi.json": {
      get: {
        tags: ["Health"],
        summary: "OpenAPI document",
        description: "This document. Unauthenticated.",
        security: [],
        responses: {
          "200": {
            description: "OpenAPI 3.1 document.",
            content: { "application/json": { schema: { type: "object" } } },
          },
        },
      },
    },
    "/v1/models": catalogueGet(
      "List models",
      "Enabled model routes plus one `agent:<id>` entry per published agent. Never requires `X-Session-Id`.",
      "ModelList",
      "Models & agents",
    ),
    "/v1/agents": catalogueGet("List agents", agentsDescription, "AgentList", "Models & agents"),
    "/agents": catalogueGet(
      "List agents (alias)",
      agentsDescription,
      "AgentList",
      "Models & agents",
    ),
    "/v1/sessions/{id}/end": {
      post: {
        tags: ["Sessions"],
        summary: "End a session",
        description:
          "Tells the gateway the user left the conversation (for example back to a menu). Ends the session named by `{id}` when it is active and owned by the calling API key, so the next request with that id gets `404 session_not_found` and the CRM shows it as ended (`end_reason: client`). Idempotent and best effort: an unknown, malformed, expired, already ended or foreign id also answers `204` and changes nothing. Clients do not have to call it; idle sessions still expire on their own.",
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            description: "The `X-Session-Id` returned by a chat or responses reply.",
            schema: { type: "string" },
          },
        ],
        responses: {
          "204": { description: "Handled. Nothing is returned, whatever the session's state." },
          ...AUTH_ERRORS,
        },
      },
    },
    "/v1/chat/completions": {
      post: {
        tags: ["Chat"],
        summary: "Create a chat completion",
        description:
          "OpenAI-compatible Chat Completions with ordered provider failover, MCP tools, agents and session tracking. With `agent_id` (or `model: agent:<id>`) the published agent runs; a client-tool call pauses the run and returns `tool_calls` (`finish_reason: tool_calls`); the next request carrying the `role: tool` results resumes it.",
        parameters: [sessionParam],
        requestBody: { required: true, content: json("ChatCompletionRequest") },
        responses: llmResponses(
          "ChatCompletion",
          "`data: {chat.completion.chunk}` lines, a final usage chunk, then `data: [DONE]`.",
          [E.invalidJson, E.invalidRequest, E.invalidAgent, E.modelNotFound, E.upstreamBadRequest],
        ),
      },
    },
    "/v1/responses": {
      post: {
        tags: ["Responses"],
        summary: "Create a response",
        description:
          "OpenAI-compatible Responses API. Forwarded natively to providers flagged `responses_api`, otherwise translated to and from Chat Completions per route step. Agents, sessions and failover work as on `/v1/chat/completions`.",
        parameters: [sessionParam],
        requestBody: { required: true, content: json("ResponsesRequest") },
        responses: llmResponses(
          "Response",
          "Responses events (`event: response.created`, `response.output_text.delta`, `response.function_call_arguments.delta`, `response.completed`, …).",
          [
            E.invalidJson,
            E.invalidRequest,
            E.invalidAgent,
            E.modelNotFound,
            E.unsupportedParameter,
            E.upstreamBadRequest,
          ],
        ),
      },
    },
    "/v1/media": catalogueGet(
      "List media",
      "Enabled media items the avatar may show.",
      "MediaList",
      "Media",
    ),
    "/v1/media/{id}/content": {
      get: {
        tags: ["Media"],
        summary: "Download media content",
        description:
          "Serves an uploaded file with HTTP Range, ETag and Last-Modified support. External-URL items redirect (302).",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          {
            name: "Range",
            in: "header",
            required: false,
            description: "Single byte range, for example `bytes=0-1023`.",
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": { description: "The whole file.", content: binary },
          "206": { description: "The requested range.", content: binary },
          "302": { description: "External-URL item: redirect to its URL." },
          "304": { description: "Not modified (ETag / Last-Modified)." },
          ...AUTH_ERRORS,
          "404": errorResponse("Unknown or disabled item, or the file is missing from storage.", [
            E.mediaNotFound,
          ]),
          "416": { description: "Range not satisfiable." },
        },
      },
    },
    "/v1/cameras": catalogueGet(
      "List cameras",
      "Enabled camera streams the avatar may show.",
      "CameraList",
      "Cameras",
    ),
  };
}

export interface OpenApiOptions {
  version: string;
  /** Absolute base URL of this gateway (no trailing slash), used as the single server. */
  serverUrl?: string;
}

let cachedSchemas: JsonObject | undefined;

export function buildOpenApiDocument(options: OpenApiOptions): JsonObject {
  cachedSchemas ??= Object.fromEntries(
    Object.entries(SCHEMAS).map(([name, schema]) => [name, toSchema(schema)]),
  );
  return {
    openapi: "3.1.0",
    info: {
      title: "AGENTX Gateway API",
      version: options.version,
      description:
        'OpenAI-compatible client API of the AGENTX Gateway: chat completions and Responses with provider failover, agents, sessions (`X-Session-Id`), and the media and camera catalogues. Errors use the OpenAI shape `{"error":{"message","type","code"}}`; on chat routes 404 always means `session_not_found`.',
      license: { name: "MIT", identifier: "MIT" },
    },
    ...(options.serverUrl ? { servers: [{ url: options.serverUrl }] } : {}),
    security: [{ bearerAuth: [] }],
    tags: [
      { name: "Chat" },
      { name: "Responses" },
      { name: "Sessions" },
      { name: "Models & agents" },
      { name: "Media" },
      { name: "Cameras" },
      { name: "Health" },
    ],
    paths: buildPaths(),
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description: "A gateway API key created in the CRM (API Keys). Shown once at creation.",
        },
      },
      schemas: cachedSchemas,
    },
  };
}
