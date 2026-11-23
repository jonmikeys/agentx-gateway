import { Validator } from "@seriousme/openapi-schema-validator";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { API_VERSION, createApiApp } from "@/server/api/app";
import { buildOpenApiDocument, OPENAPI_PATH } from "@/server/api/openapi";
import { resetEnvCacheForTests } from "@/server/env";

type Operation = {
  parameters?: { name: string; in: string }[];
  responses: Record<string, { content?: Record<string, { examples?: Record<string, unknown> }> }>;
  security?: unknown[];
};
type Document = {
  openapi: string;
  servers?: { url: string }[];
  paths: Record<string, Record<string, Operation>>;
};

const document = buildOpenApiDocument({
  version: "0.0.0-test",
  serverUrl: "https://gw.example.com",
}) as Document;

/** Hono `:param` to OpenAPI `{param}`. */
const toOpenApiPath = (path: string) => path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");

function exampleCodes(operation: Operation, status: string): string[] {
  const examples = operation.responses[status]?.content?.["application/json"]?.examples ?? {};
  return Object.keys(examples);
}

describe("OpenAPI document", () => {
  it("is a valid OpenAPI 3.1 document", async () => {
    const result = await new Validator().validate(structuredClone(document));
    expect(result.errors ?? []).toEqual([]);
    expect(result.valid).toBe(true);
    expect(document.openapi).toBe("3.1.0");
  });

  it("lists every client route", () => {
    expect(Object.keys(document.paths).sort()).toEqual(
      [
        "/agents",
        "/health",
        "/v1/agents",
        "/v1/cameras",
        "/v1/chat/completions",
        "/v1/media",
        "/v1/media/{id}/content",
        "/v1/models",
        "/v1/openapi.json",
        "/v1/responses",
      ].sort(),
    );
  });

  it("documents exactly the routes registered on the Hono app", () => {
    const app = createApiApp({ clientAuth: async (_c, next) => next() });
    const registered = app.routes
      .filter((route) => route.method !== "ALL")
      .map((route) => `${route.method.toLowerCase()} ${toOpenApiPath(route.path)}`);
    const documented = Object.entries(document.paths).flatMap(([path, operations]) =>
      Object.keys(operations).map((method) => `${method} ${path}`),
    );
    expect([...new Set(registered)].sort()).toEqual(documented.sort());
  });

  it("documents X-Session-Id and the error codes on the chat routes", () => {
    for (const path of ["/v1/chat/completions", "/v1/responses"]) {
      const operation = document.paths[path]?.post as Operation;
      expect(
        operation.parameters?.some((p) => p.name === "X-Session-Id" && p.in === "header"),
      ).toBe(true);
      expect(exampleCodes(operation, "404")).toEqual(["session_not_found"]);
      expect(exampleCodes(operation, "400")).toEqual(
        expect.arrayContaining(["invalid_agent", "model_not_found"]),
      );
      expect(exampleCodes(operation, "429")).toEqual(["rate_limit_exceeded"]);
      expect(exampleCodes(operation, "502")).toEqual(
        expect.arrayContaining([
          "all_providers_failed",
          "upstream_auth_failed",
          "upstream_not_found",
          "upstream_error",
          "agent_run_failed",
        ]),
      );
      expect(Object.keys(operation.responses["200"]?.content ?? {})).toEqual(
        expect.arrayContaining(["application/json", "text/event-stream"]),
      );
    }
  });

  it("marks /health and the document itself as public", () => {
    expect(document.paths["/health"]?.get?.security).toEqual([]);
    expect(document.paths["/v1/openapi.json"]?.get?.security).toEqual([]);
    expect(document.paths["/v1/models"]?.get?.security).toBeUndefined();
  });
});

describe("GET /v1/openapi.json", () => {
  beforeAll(() => {
    vi.stubEnv("DATABASE_URL", "postgres://user:pass@localhost:5432/agentx");
    vi.stubEnv("GATEWAY_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
    vi.stubEnv("ADMIN_USERNAME", "admin");
    vi.stubEnv("ADMIN_PASSWORD", "password");
    vi.stubEnv("PUBLIC_BASE_URL", "");
    resetEnvCacheForTests();
  });
  afterAll(() => {
    vi.unstubAllEnvs();
    resetEnvCacheForTests();
  });

  // Real client auth: the document must be served without an API key.
  const app = createApiApp();

  it("is served without an API key, with this server and version", async () => {
    const response = await app.request(`http://gw.local:3000${OPENAPI_PATH}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Document & { info: { version: string } };
    expect(body.info.version).toBe(API_VERSION);
    expect(body.servers).toEqual([{ url: "http://gw.local:3000" }]);
  });

  it("does not open other /v1 routes", async () => {
    expect((await app.request("/v1/openapi.json/extra")).status).toBe(401);
    expect((await app.request("/v1/models")).status).toBe(401);
  });
});
