import { desc } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { createApiApp } from "@/server/api/app";
import { closeDatabase, getDb } from "@/server/db/client";
import { llmRequests } from "@/server/db/schema";
import { circuitBreaker } from "@/server/gateway/circuit-breaker";
import { revokeApiKey } from "@/server/services/api-keys";
import { type MockUpstream, startMockUpstream } from "../support/mock-upstream";
import {
  prepareDatabase,
  resetGatewayState,
  seedApiKey,
  seedProvider,
  seedRoute,
  waitFor,
} from "./support";

const databaseUrl = inject("databaseUrl");
const UPSTREAM_KEY = "sk-upstream-secret-1234";

describe("client API: routing, failover and auth", () => {
  const app = createApiApp();
  let upstreamA: MockUpstream;
  let upstreamB: MockUpstream;
  let key: string;
  let keyId: string;
  let providerA: { id: string };
  let providerB: { id: string };

  beforeAll(async () => {
    await prepareDatabase(databaseUrl);
    upstreamA = await startMockUpstream({ apiKey: UPSTREAM_KEY, slowMs: 1500 });
    upstreamB = await startMockUpstream({ slowMs: 1500 });
  });

  afterAll(async () => {
    await upstreamA.close();
    await upstreamB.close();
    await closeDatabase();
  });

  beforeEach(async () => {
    await resetGatewayState();
    upstreamA.reset();
    upstreamB.reset();
    providerA = await seedProvider("Alpha", `${upstreamA.url}/`, UPSTREAM_KEY);
    providerB = await seedProvider("Beta", upstreamB.url);
    const created = await seedApiKey();
    key = created.key;
    keyId = created.apiKey.id;
  });

  function chat(body: Record<string, unknown>, headers: Record<string, string> = {}, bearer = key) {
    return app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bearer}`,
        "Content-Type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    });
  }

  /** Newest row once at least `expectedCount` rows exist (rows are written asynchronously). */
  async function lastRequestRow(expectedCount = 1) {
    return waitFor(async () => {
      const rows = await getDb().select().from(llmRequests).orderBy(desc(llmRequests.startedAt));
      return rows.length >= expectedCount ? rows[0] : undefined;
    });
  }

  const userMessage = [{ role: "user", content: "secret user prompt text" }];

  describe("passthrough", () => {
    it("forwards a JSON completion with model rewrite and unknown fields", async () => {
      await seedRoute("avatar-default", [{ providerId: providerA.id, model: "ok" }]);
      const response = await chat({
        model: "avatar-default",
        messages: userMessage,
        reasoning_effort: "low",
        custom_flag: { nested: true },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("x-gateway-provider")).toBe("Alpha");
      const json = await response.json();
      expect(json.choices[0].message.content).toBe("Hello there");

      const [received] = upstreamA.chatRequests();
      expect(received.body?.model).toBe("ok");
      expect(received.body).not.toHaveProperty("agent_id");
      expect(received.body?.reasoning_effort).toBe("low");
      expect(received.body?.custom_flag).toEqual({ nested: true });
      expect(received.headers.authorization).toBe(`Bearer ${UPSTREAM_KEY}`);
      expect(received.path).toBe("/chat/completions");
    });

    it("streams chunks and [DONE] with SSE headers and requests usage", async () => {
      await seedRoute("avatar-default", [{ providerId: providerA.id, model: "ok" }]);
      const response = await chat({ model: "avatar-default", messages: userMessage, stream: true });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      expect(response.headers.get("cache-control")).toContain("no-cache");
      expect(response.headers.get("x-accel-buffering")).toBe("no");
      expect(response.headers.get("x-gateway-provider")).toBe("Alpha");

      const text = await response.text();
      expect(text).toContain('"content":"Hel"');
      expect(text).toContain('"content":"there"');
      expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
      expect(upstreamA.chatRequests()[0].body?.stream_options).toEqual({ include_usage: true });
    });

    it("respects a client-provided stream_options", async () => {
      await seedRoute("avatar-default", [{ providerId: providerA.id, model: "ok" }]);
      const response = await chat({
        model: "avatar-default",
        messages: userMessage,
        stream: true,
        stream_options: { include_usage: false },
      });
      await response.text();
      expect(upstreamA.chatRequests()[0].body?.stream_options).toEqual({ include_usage: false });
    });

    it("writes an llm_requests row with attempts and usage but no content", async () => {
      await seedRoute("avatar-default", [{ providerId: providerA.id, model: "ok" }]);
      const response = await chat({ model: "avatar-default", messages: userMessage, stream: true });
      await response.text();
      const row = await lastRequestRow();
      expect(row).toMatchObject({
        apiKeyId: keyId,
        routeSlug: "avatar-default",
        providerId: providerA.id,
        upstreamModel: "ok",
        stream: true,
        status: "ok",
        httpStatus: 200,
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      });
      expect(row.ttftMs).not.toBeNull();
      expect(row.attempts).toHaveLength(1);
      expect(row.attempts[0]).toMatchObject({
        provider_id: providerA.id,
        provider_name: "Alpha",
        model: "ok",
        outcome: "ok",
      });
      const serialized = JSON.stringify(row);
      expect(serialized).not.toContain("secret user prompt");
      expect(serialized).not.toContain("Hello there");
      expect(serialized).not.toContain(UPSTREAM_KEY);
    });

    it("records non-stream usage", async () => {
      await seedRoute("avatar-default", [{ providerId: providerA.id, model: "ok" }]);
      await chat({ model: "avatar-default", messages: userMessage });
      const row = await lastRequestRow();
      expect(row.stream).toBe(false);
      expect(row.usage?.total_tokens).toBe(8);
    });
  });

  describe("route resolution", () => {
    it("returns 400 model_not_found for an unknown route (never 404)", async () => {
      await seedRoute("avatar-default", [{ providerId: providerA.id, model: "ok" }]);
      const response = await chat({ model: "nope", messages: userMessage });
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe("model_not_found");
    });

    it("returns 400 model_not_found for a disabled route", async () => {
      await seedRoute("avatar-default", [{ providerId: providerA.id, model: "ok" }]);
      await seedRoute("off", [{ providerId: providerA.id, model: "ok" }], false);
      const response = await chat({ model: "off", messages: userMessage });
      expect(response.status).toBe(400);
    });

    it("uses the default route when model is absent, empty or 'default'", async () => {
      await seedRoute("avatar-default", [{ providerId: providerA.id, model: "ok" }]);
      await seedRoute("other", [{ providerId: providerB.id, model: "ok" }]);
      for (const model of [undefined, "", "default"]) {
        const response = await chat({
          ...(model === undefined ? {} : { model }),
          messages: userMessage,
        });
        expect(response.status, String(model)).toBe(200);
        expect(response.headers.get("x-gateway-provider")).toBe("Alpha");
      }
    });

    it("rejects a missing messages array with 400", async () => {
      await seedRoute("avatar-default", [{ providerId: providerA.id, model: "ok" }]);
      const response = await chat({ model: "avatar-default" });
      expect(response.status).toBe(400);
    });

    it("lists enabled routes at /v1/models without X-Session-Id", async () => {
      await seedRoute("avatar-default", [{ providerId: providerA.id, model: "ok" }]);
      await seedRoute("hidden", [{ providerId: providerA.id, model: "ok" }], false);
      const response = await app.request("/v1/models", {
        headers: { Authorization: `Bearer ${key}` },
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.object).toBe("list");
      expect(body.data.map((entry: { id: string }) => entry.id)).toEqual(["avatar-default"]);
      expect(body.data[0]).toMatchObject({ object: "model", owned_by: "agentx-gateway" });
      expect(typeof body.data[0].created).toBe("number");
    });
  });

  describe("failover", () => {
    it.each([
      ["fail-500", "http_error"],
      ["fail-429", "http_error"],
      ["fail-408", "http_error"],
    ])("fails over from %s to the next step", async (model, outcome) => {
      await seedRoute("avatar-default", [
        { providerId: providerA.id, model },
        { providerId: providerB.id, model: "ok" },
      ]);
      const response = await chat({ model: "avatar-default", messages: userMessage });
      expect(response.status).toBe(200);
      expect(response.headers.get("x-gateway-provider")).toBe("Beta");
      const row = await lastRequestRow();
      expect(row.attempts.map((attempt) => attempt.outcome)).toEqual([outcome, "ok"]);
      expect(row.attempts[0].http_status).toBe(Number(model.slice(5)));
      expect(row.providerId).toBe(providerB.id);
    });

    it("fails over on timeout, in route order", async () => {
      await seedRoute("avatar-default", [
        { providerId: providerA.id, model: "slow", timeoutMs: 300 },
        { providerId: providerB.id, model: "ok" },
      ]);
      const response = await chat({ model: "avatar-default", messages: userMessage });
      expect(response.status).toBe(200);
      expect(response.headers.get("x-gateway-provider")).toBe("Beta");
      const row = await lastRequestRow();
      expect(row.attempts[0]).toMatchObject({ provider_name: "Alpha", outcome: "timeout" });
    });

    it("fails over for streams before the first chunk, and on an empty stream", async () => {
      await seedRoute("avatar-default", [
        { providerId: providerA.id, model: "fail-503" },
        { providerId: providerB.id, model: "empty-stream" },
        { providerId: providerA.id, model: "ok" },
      ]);
      const response = await chat({ model: "avatar-default", messages: userMessage, stream: true });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("[DONE]");
      const row = await lastRequestRow();
      expect(row.attempts.map((attempt) => attempt.outcome)).toEqual([
        "http_error",
        "empty_stream",
        "ok",
      ]);
    });

    it("never fails over after the first chunk: the stream ends with an error chunk", async () => {
      await seedRoute("avatar-default", [
        { providerId: providerA.id, model: "midstream-fail" },
        { providerId: providerB.id, model: "ok" },
      ]);
      const response = await chat({ model: "avatar-default", messages: userMessage, stream: true });
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain('"content":"Hel"');
      expect(text).toContain('"code":"upstream_stream_error"');
      expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
      expect(upstreamB.chatRequests()).toHaveLength(0);
      const row = await lastRequestRow();
      expect(row).toMatchObject({ status: "error", errorCode: "upstream_stream_error" });
    });

    it("opens the circuit after 3 failures and skips the provider", async () => {
      await seedRoute("avatar-default", [
        { providerId: providerA.id, model: "fail-500" },
        { providerId: providerB.id, model: "ok" },
      ]);
      for (let index = 0; index < 3; index += 1) {
        expect((await chat({ model: "avatar-default", messages: userMessage })).status).toBe(200);
      }
      expect(upstreamA.chatRequests()).toHaveLength(3);
      expect(circuitBreaker.state(providerA.id)).toBe("open");

      const response = await chat({ model: "avatar-default", messages: userMessage });
      expect(response.status).toBe(200);
      expect(upstreamA.chatRequests()).toHaveLength(3);
      const row = await lastRequestRow(4);
      expect(row.attempts[0]).toMatchObject({ outcome: "skipped_circuit_open" });
    });

    it("skips disabled providers", async () => {
      const { updateProvider } = await import("@/server/services/providers");
      await updateProvider(providerA.id, { enabled: false });
      await seedRoute("avatar-default", [
        { providerId: providerA.id, model: "ok" },
        { providerId: providerB.id, model: "ok" },
      ]);
      const response = await chat({ model: "avatar-default", messages: userMessage });
      expect(response.headers.get("x-gateway-provider")).toBe("Beta");
      expect(upstreamA.chatRequests()).toHaveLength(0);
    });

    it("returns 502 all_providers_failed with a summary when every step fails", async () => {
      await seedRoute("avatar-default", [
        { providerId: providerA.id, model: "fail-500" },
        { providerId: providerB.id, model: "fail-429" },
      ]);
      const response = await chat({ model: "avatar-default", messages: userMessage });
      expect(response.status).toBe(502);
      const body = await response.json();
      expect(body.error.code).toBe("all_providers_failed");
      expect(body.error.message).toContain("Alpha");
      expect(body.error.message).toContain("Beta");
      expect(body.error.message).not.toContain(UPSTREAM_KEY);
      const row = await lastRequestRow();
      expect(row).toMatchObject({
        status: "error",
        httpStatus: 502,
        errorCode: "all_providers_failed",
      });
    });
  });

  describe("upstream error mapping", () => {
    it.each([
      ["fail-404", 502, "upstream_not_found"],
      ["fail-401", 502, "upstream_auth_failed"],
      ["fail-403", 502, "upstream_auth_failed"],
      ["bad-request-400", 400, "upstream_bad_request"],
      ["bad-request-422", 400, "upstream_bad_request"],
    ])("maps %s to %i %s without failing over", async (model, status, code) => {
      await seedRoute("avatar-default", [
        { providerId: providerA.id, model },
        { providerId: providerB.id, model: "ok" },
      ]);
      const response = await chat({ model: "avatar-default", messages: userMessage });
      expect(response.status).toBe(status);
      expect((await response.json()).error.code).toBe(code);
      expect(upstreamB.chatRequests()).toHaveLength(0);
    });

    it("passes the upstream message for bad requests", async () => {
      await seedRoute("avatar-default", [{ providerId: providerA.id, model: "bad-request-400" }]);
      const response = await chat({ model: "avatar-default", messages: userMessage });
      expect((await response.json()).error.message).toBe("Mock bad-request-400");
    });
  });

  describe("client authentication", () => {
    beforeEach(async () => {
      await seedRoute("avatar-default", [{ providerId: providerB.id, model: "ok" }]);
    });

    it("rejects unknown and missing keys with 401 invalid_api_key", async () => {
      const unknown = await chat(
        { messages: userMessage },
        {},
        "agx_unknownunknownunknownunknown123",
      );
      expect(unknown.status).toBe(401);
      expect((await unknown.json()).error.code).toBe("invalid_api_key");
      const missing = await app.request("/v1/models");
      expect(missing.status).toBe(401);
    });

    it("rejects a revoked key immediately (cache invalidated in-process)", async () => {
      expect((await chat({ messages: userMessage })).status).toBe(200);
      await revokeApiKey(keyId);
      const response = await chat({ messages: userMessage });
      expect(response.status).toBe(401);
      expect((await response.json()).error.code).toBe("invalid_api_key");
    });

    it("updates last_used_at", async () => {
      await chat({ messages: userMessage });
      const { listApiKeys } = await import("@/server/services/api-keys");
      const used = await waitFor(async () => {
        const [found] = await listApiKeys();
        return found.last_used_at ?? undefined;
      });
      expect(used).toBeTruthy();
    });

    it("enforces the IP allowlist (403 ip_not_allowed) via forwarded headers", async () => {
      const restricted = await seedApiKey({ ip_allowlist: ["203.0.113.0/24", "2001:db8::/32"] });
      const call = (headers: Record<string, string>) =>
        chat({ messages: userMessage }, headers, restricted.key);

      const noIp = await call({});
      expect(noIp.status).toBe(403);
      expect((await noIp.json()).error.code).toBe("ip_not_allowed");
      expect((await call({ "x-forwarded-for": "198.51.100.7" })).status).toBe(403);
      expect((await call({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" })).status).toBe(200);
      expect((await call({ "x-real-ip": "2001:db8::42" })).status).toBe(200);
      expect((await call({ "x-forwarded-for": "garbage" })).status).toBe(403);
    });

    it("enforces the requests-per-minute limit with Retry-After", async () => {
      const limited = await seedApiKey({ rpm_limit: 2 });
      const call = () => chat({ messages: userMessage }, {}, limited.key);
      expect((await call()).status).toBe(200);
      expect((await call()).status).toBe(200);
      const third = await call();
      expect(third.status).toBe(429);
      expect((await third.json()).error.code).toBe("rate_limit_exceeded");
      expect(Number(third.headers.get("retry-after"))).toBeGreaterThan(0);
    });

    it("enforces the tokens-per-day limit using recorded usage", async () => {
      const limited = await seedApiKey({ tokens_per_day_limit: 10 });
      const call = () => chat({ messages: userMessage }, {}, limited.key);
      const { readCounter, dayWindowStart } = await import("@/server/gateway/rate-counters");
      const used = () => readCounter(limited.apiKey.id, "day", dayWindowStart(new Date()));
      const reached = async (target: number) =>
        waitFor(async () => ((await used()) >= target ? true : undefined));

      expect((await call()).status).toBe(200);
      await reached(8);
      expect((await call()).status).toBe(200);
      await reached(16);
      const blocked = await call();
      expect(blocked.status).toBe(429);
      expect(blocked.headers.get("retry-after")).toBeTruthy();
    });
  });
});
