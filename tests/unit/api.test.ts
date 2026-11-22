import { describe, expect, it } from "vitest";
import { createApiApp } from "@/server/api/app";
import { openAIError } from "@/server/api/errors";

describe("openAIError", () => {
  it("produces the OpenAI error shape", async () => {
    const response = openAIError(400, "invalid_agent", "Unknown agent", "invalid_request_error");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { message: "Unknown agent", type: "invalid_request_error", code: "invalid_agent" },
    });
  });
});

describe("API app routing", () => {
  const app = createApiApp();

  it("returns an OpenAI-shaped not_found (never session_not_found) for unknown /v1 routes", async () => {
    const response = await app.request("/v1/unknown");
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error.code).toBe("not_found");
    expect(body.error).toHaveProperty("message");
    expect(body.error).toHaveProperty("type");
  });

  it("returns not_found for unknown /agents sub-routes", async () => {
    expect((await app.request("/agents/x")).status).toBe(404);
  });

  it("allows the documented headers and exposes X-Session-Id via CORS on /v1/*", async () => {
    const preflight = await app.request("/v1/chat/completions", {
      method: "OPTIONS",
      headers: {
        origin: "http://example.com",
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization,x-session-id,content-type",
      },
    });
    const allowed = (preflight.headers.get("access-control-allow-headers") ?? "").toLowerCase();
    expect(allowed).toContain("authorization");
    expect(allowed).toContain("x-session-id");
    expect(allowed).toContain("content-type");

    const actual = await app.request("/v1/unknown", { headers: { origin: "http://example.com" } });
    expect(actual.headers.get("access-control-expose-headers")).toContain("X-Session-Id");
  });

  it("applies CORS on /agents", async () => {
    const response = await app.request("/agents", { headers: { origin: "http://example.com" } });
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-expose-headers")).toContain("X-Session-Id");
  });
});
