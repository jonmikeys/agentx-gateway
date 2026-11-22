import { describe, expect, it } from "vitest";
import { buildUpstreamBody, extractUsage } from "@/server/gateway/chat-proxy";
import {
  classifyStatus,
  extractUpstreamMessage,
  isFailoverStatus,
  mapUpstreamError,
} from "@/server/gateway/upstream-errors";

describe("failover classifier", () => {
  it("fails over on 408, 429 and 5xx only", () => {
    for (const status of [408, 429, 500, 502, 503, 504, 599]) {
      expect(isFailoverStatus(status)).toBe(true);
    }
    for (const status of [400, 401, 403, 404, 413, 422]) {
      expect(isFailoverStatus(status)).toBe(false);
    }
  });

  it("classifies non-failover statuses", () => {
    expect(classifyStatus(400)).toBe("bad_request");
    expect(classifyStatus(422)).toBe("bad_request");
    expect(classifyStatus(401)).toBe("auth");
    expect(classifyStatus(403)).toBe("auth");
    expect(classifyStatus(404)).toBe("not_found");
    expect(classifyStatus(409)).toBe("other");
  });
});

describe("upstream error mapping", () => {
  it("maps 400/422 to 400 upstream_bad_request with the upstream message", () => {
    expect(mapUpstreamError(422, "OpenAI", "bad field")).toMatchObject({
      status: 400,
      code: "upstream_bad_request",
      message: "bad field",
    });
  });

  it("maps 401/403 to 502 upstream_auth_failed", () => {
    for (const status of [401, 403]) {
      expect(mapUpstreamError(status, "OpenAI")).toMatchObject({
        status: 502,
        code: "upstream_auth_failed",
      });
    }
  });

  it("never returns 404 to the client", () => {
    expect(mapUpstreamError(404, "OpenAI")).toMatchObject({
      status: 502,
      code: "upstream_not_found",
    });
  });

  it("maps other 4xx to 502 upstream_error", () => {
    expect(mapUpstreamError(409, "OpenAI")).toMatchObject({ status: 502, code: "upstream_error" });
  });

  it("extracts messages from error bodies", () => {
    expect(extractUpstreamMessage('{"error":{"message":"nope"}}')).toBe("nope");
    expect(extractUpstreamMessage('{"error":"plain"}')).toBe("plain");
    expect(extractUpstreamMessage("<html>")).toBeUndefined();
  });
});

describe("upstream body building", () => {
  it("rewrites the model and keeps unknown fields", () => {
    const body = buildUpstreamBody(
      { model: "avatar", messages: [], foo: { bar: 1 } },
      "gpt-x",
      false,
    );
    expect(body).toEqual({ model: "gpt-x", messages: [], foo: { bar: 1 } });
  });

  it("requests usage for streams but respects a client value", () => {
    expect(buildUpstreamBody({ messages: [] }, "m", true)).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
    });
    expect(
      buildUpstreamBody({ messages: [], stream_options: { include_usage: false } }, "m", true)
        .stream_options,
    ).toEqual({ include_usage: false });
  });

  it("extracts usage", () => {
    expect(extractUsage({ usage: { prompt_tokens: 2, completion_tokens: 3 } })).toEqual({
      prompt_tokens: 2,
      completion_tokens: 3,
      total_tokens: 5,
    });
    expect(extractUsage({ usage: null })).toBeUndefined();
    expect(extractUsage({})).toBeUndefined();
  });
});
