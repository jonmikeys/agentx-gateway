import { asc, desc, eq } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  inject,
  it,
  vi,
} from "vitest";
import { createAdminApp } from "@/server/api/admin-app";
import { createApiApp } from "@/server/api/app";
import { closeDatabase, getDb } from "@/server/db/client";
import { llmRequests, sessions, transcriptItems } from "@/server/db/schema";
import { type MockUpstream, startMockUpstream } from "../support/mock-upstream";
import {
  readUnityJson,
  readUnityStream,
  unityRequestBody,
  unityToolRoundBody,
} from "../support/unity-responses-client";
import {
  adminHeaders,
  prepareDatabase,
  resetGatewayState,
  seedApiKey,
  seedProvider,
  seedRoute,
  waitFor,
} from "./support";

const databaseUrl = inject("databaseUrl");
const SESSION_HEADER = "x-session-id";

type Json = Record<string, unknown>;

/** Splits an SSE body into `{event, data}` pairs. */
function sseFrames(text: string): { event: string | null; data: string }[] {
  return text
    .split("\n\n")
    .filter((frame) => frame.trim().length > 0)
    .map((frame) => {
      const lines = frame.split("\n");
      const event = lines.find((line) => line.startsWith("event: "))?.slice(7) ?? null;
      const data = lines
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice(6))
        .join("\n");
      return { event, data };
    });
}

describe("POST /v1/responses", () => {
  const app = createApiApp();
  const admin = createAdminApp();
  let upstream: MockUpstream;
  let key: string;
  let keyId: string;
  let nativeProvider: { id: string };
  let chatProvider: { id: string };

  beforeAll(async () => {
    await prepareDatabase(databaseUrl);
    upstream = await startMockUpstream({ slowMs: 1500 });
  });

  afterAll(async () => {
    await upstream.close();
    await closeDatabase();
  });

  beforeEach(async () => {
    await resetGatewayState();
    upstream.reset();
    nativeProvider = await seedProvider("Native", upstream.url, null, true);
    chatProvider = await seedProvider("Chatty", upstream.url, null, false);
    const created = await seedApiKey();
    key = created.key;
    keyId = created.apiKey.id;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function respond(body: Json, headers: Record<string, string> = {}) {
    return app.request("/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  }

  async function rows(count: number) {
    return waitFor(async () => {
      const found = await getDb().select().from(llmRequests).orderBy(asc(llmRequests.startedAt));
      return found.length >= count ? found : undefined;
    });
  }

  async function items(sessionId: string) {
    return getDb()
      .select()
      .from(transcriptItems)
      .where(eq(transcriptItems.sessionId, sessionId))
      .orderBy(asc(transcriptItems.seq));
  }

  async function route(slug: string, mode: "native" | "chat", model: string) {
    await seedRoute(slug, [
      { providerId: (mode === "native" ? nativeProvider : chatProvider).id, model },
    ]);
  }

  describe("translated mode (provider without responses_api)", () => {
    it("answers a JSON request with a Responses object", async () => {
      await route("avatar-default", "chat", "ok");
      const response = await respond({ model: "avatar-default", input: "hi" });
      expect(response.status).toBe(200);
      expect(response.headers.get(SESSION_HEADER)).toMatch(/^[0-9a-f-]{36}$/);
      const json = (await response.json()) as Json;
      expect(json).toMatchObject({
        object: "response",
        status: "completed",
        model: "avatar-default",
        usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
      });
      const [message] = json.output as Json[];
      expect(message).toMatchObject({ type: "message", role: "assistant" });
      expect(upstream.chatRequests()).toHaveLength(1);
      expect(upstream.responsesRequests()).toHaveLength(0);
      expect(upstream.chatRequests()[0].body).toMatchObject({
        model: "ok",
        messages: [{ role: "user", content: "hi" }],
      });
    });

    it("streams spec-shaped events with sequence numbers, no [DONE], and Unity can parse it", async () => {
      await route("avatar-default", "chat", "reasoning");
      const response = await respond({ model: "avatar-default", input: "hi", stream: true });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      expect(response.headers.get(SESSION_HEADER)).toBeTruthy();
      const text = await response.text();
      expect(text).not.toContain("[DONE]");

      const frames = sseFrames(text);
      const parsed = frames.map((frame) => JSON.parse(frame.data) as Json);
      expect(frames.map((frame) => frame.event)).toEqual(parsed.map((entry) => entry.type));
      expect(parsed.map((entry) => entry.sequence_number)).toEqual(parsed.map((_, index) => index));
      expect(parsed[0].type).toBe("response.created");
      expect(parsed.at(-1)?.type).toBe("response.completed");

      const round = readUnityStream(text);
      expect(round.text).toBe("Hello from the reasoning model.");
      expect(round.reasoning).toBe("The user greets me. I should answer warmly.");
      expect(upstream.chatRequests()[0].body?.stream_options).toEqual({ include_usage: true });
    });

    it("translates tools, tool_choice and a function call back to function_call items", async () => {
      await route("avatar-default", "chat", "tool-call");
      const response = await respond({ ...unityRequestBody("avatar-default", true) });
      const text = await response.text();
      const round = readUnityStream(text);
      expect(round.text).toBe("Let me show that. ");
      expect(round.toolCalls).toEqual([
        { id: "call_mock_1", name: "show_image", arguments: '{"media_id":"sunset"}' },
      ]);
      const received = upstream.chatRequests()[0].body as Json;
      expect(received).toMatchObject({
        tool_choice: "auto",
        reasoning_effort: "medium",
        temperature: 0.7,
        tools: [{ type: "function", function: { name: "show_image" } }],
      });
      expect(received).not.toHaveProperty("store");
      expect(received).not.toHaveProperty("include");
      expect(received).not.toHaveProperty("input");
    });

    it("ends with response.failed when the upstream breaks mid-stream", async () => {
      await route("avatar-default", "chat", "midstream-fail");
      const response = await respond({ model: "avatar-default", input: "hi", stream: true });
      const text = await response.text();
      const frames = sseFrames(text).map((frame) => JSON.parse(frame.data) as Json);
      expect(frames.at(-1)).toMatchObject({
        type: "response.failed",
        response: { status: "failed", error: { code: "upstream_stream_error" } },
      });
      expect(() => readUnityStream(text)).toThrow(/stream failed/);
      const [row] = await rows(1);
      expect(row).toMatchObject({ status: "error", errorCode: "upstream_stream_error" });
    });
  });

  describe("native mode (provider with responses_api)", () => {
    it("forwards a JSON request to /responses with model rewritten and unknown fields kept", async () => {
      await route("avatar-default", "native", "ok");
      const response = await respond({
        model: "avatar-default",
        input: "hi",
        store: false,
        custom_flag: { nested: true },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("x-gateway-provider")).toBe("Native");
      expect(response.headers.get(SESSION_HEADER)).toBeTruthy();
      const round = readUnityJson(await response.text());
      expect(round.text).toBe("Hello there");
      expect(upstream.chatRequests()).toHaveLength(0);
      const [received] = upstream.responsesRequests();
      expect(received.body).toMatchObject({
        model: "ok",
        input: "hi",
        store: false,
        custom_flag: { nested: true },
      });
    });

    it("passes the event stream through untouched, without [DONE], and captures it", async () => {
      await route("avatar-default", "native", "tool-call");
      const response = await respond(unityRequestBody("avatar-default", true));
      expect(response.headers.get(SESSION_HEADER)).toBeTruthy();
      const text = await response.text();
      expect(text).not.toContain("[DONE]");
      expect(text).toContain("event: response.output_text.delta");
      const round = readUnityStream(text);
      expect(round.text).toBe("Let me show that.");
      expect(round.toolCalls[0]).toMatchObject({ id: "call_mock_1", name: "show_image" });
      expect(upstream.responsesRequests()[0].body).toMatchObject({
        stream: true,
        include: ["reasoning.encrypted_content"],
      });

      const [row] = await rows(1);
      expect(row).toMatchObject({
        clientApi: "responses",
        upstreamApi: "responses",
        stream: true,
        status: "ok",
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      });
      const stored = await items(String(row.sessionId));
      expect(stored.map((item) => item.kind)).toEqual([
        "system_prompt",
        "user_message",
        "assistant_message",
        "tool_call",
      ]);
      expect(stored[3]).toMatchObject({
        toolName: "show_image",
        toolCallId: "call_mock_1",
        toolArgs: { media_id: "sunset" },
      });
    });

    it("ends with response.failed when the upstream breaks mid-stream, with no failover", async () => {
      await seedRoute("avatar-default", [
        { providerId: nativeProvider.id, model: "midstream-fail" },
        { providerId: chatProvider.id, model: "ok" },
      ]);
      const response = await respond({ model: "avatar-default", input: "hi", stream: true });
      const frames = sseFrames(await response.text()).map(
        (frame) => JSON.parse(frame.data) as Json,
      );
      expect(frames.at(-1)?.type).toBe("response.failed");
      const [row] = await rows(1);
      expect(row.attempts).toHaveLength(1);
      expect(row).toMatchObject({ status: "error", errorCode: "upstream_stream_error" });
    });

    it("rejects previous_response_id in both modes", async () => {
      await route("native", "native", "ok");
      await route("chatty", "chat", "ok");
      for (const model of ["native", "chatty"]) {
        const response = await respond({ model, input: "hi", previous_response_id: "resp_1" });
        expect(response.status).toBe(400);
        const body = (await response.json()) as { error: { code: string; message: string } };
        expect(body.error.code).toBe("unsupported_parameter");
        expect(body.error.message).toContain("stateless");
      }
    });

    it("accepts non-function tools natively but rejects them on a route with a translated step", async () => {
      await route("native", "native", "ok");
      await route("chatty", "chat", "ok");
      const tools = [{ type: "web_search" }];
      expect((await respond({ model: "native", input: "hi", tools })).status).toBe(200);
      const rejected = await respond({ model: "chatty", input: "hi", tools });
      expect(rejected.status).toBe(400);
      expect(((await rejected.json()) as { error: { code: string } }).error.code).toBe(
        "unsupported_tool",
      );
    });
  });

  describe("failover across modes", () => {
    it("fails over from a native step to a translated step (JSON and stream)", async () => {
      await seedRoute("avatar-default", [
        { providerId: nativeProvider.id, model: "fail-503" },
        { providerId: chatProvider.id, model: "ok" },
      ]);
      const json = await respond({ model: "avatar-default", input: "hi" });
      expect(json.status).toBe(200);
      expect(json.headers.get("x-gateway-provider")).toBe("Chatty");
      expect(((await json.json()) as Json).model).toBe("avatar-default");

      const stream = await respond({ model: "avatar-default", input: "hi", stream: true });
      expect(stream.status).toBe(200);
      expect(readUnityStream(await stream.text()).text).toBe("Hello there");

      const found = await rows(2);
      expect(found[0].attempts.map((attempt) => attempt.outcome)).toEqual(["http_error", "ok"]);
      expect(found[0]).toMatchObject({ clientApi: "responses", upstreamApi: "chat" });
      expect(found[1]).toMatchObject({ clientApi: "responses", upstreamApi: "chat", stream: true });
    });

    it("fails over from a translated step to a native step", async () => {
      await seedRoute("avatar-default", [
        { providerId: chatProvider.id, model: "fail-500" },
        { providerId: nativeProvider.id, model: "ok" },
      ]);
      const response = await respond({ model: "avatar-default", input: "hi", stream: true });
      expect(readUnityStream(await response.text()).text).toBe("Hello there");
      const [row] = await rows(1);
      expect(row).toMatchObject({ clientApi: "responses", upstreamApi: "responses" });
    });

    it("fails over a native stream that ends before any output", async () => {
      await seedRoute("avatar-default", [
        { providerId: nativeProvider.id, model: "empty-stream" },
        { providerId: chatProvider.id, model: "ok" },
      ]);
      const response = await respond({ model: "avatar-default", input: "hi", stream: true });
      expect(readUnityStream(await response.text()).text).toBe("Hello there");
      const [row] = await rows(1);
      expect(row.attempts.map((attempt) => attempt.outcome)).toEqual(["empty_stream", "ok"]);
    });

    it("maps non-failover upstream errors without a 404 and reports 502 when all fail", async () => {
      await route("bad", "native", "bad-request-400");
      await route("gone", "chat", "fail-404");
      expect((await respond({ model: "bad", input: "hi" })).status).toBe(400);
      const gone = await respond({ model: "gone", input: "hi" });
      expect(gone.status).toBe(502);
      await route("down", "native", "fail-500");
      const down = await respond({ model: "down", input: "hi" });
      expect(down.status).toBe(502);
      expect(((await down.json()) as { error: { code: string } }).error.code).toBe(
        "all_providers_failed",
      );
    });
  });

  describe.each([["native"], ["chat"]] as const)(
    "function call round trip (%s upstream)",
    (mode) => {
      it("links the result to the call and does not start a new turn", async () => {
        await route("avatar-default", mode, "tool-call");
        const first = await respond(unityRequestBody("avatar-default", true));
        const sessionId = first.headers.get(SESSION_HEADER) as string;
        const firstText = await first.text();
        const output = (
          JSON.parse(
            sseFrames(firstText).find((frame) => frame.event === "response.completed")?.data ??
              "{}",
          ) as { response: { output: Json[] } }
        ).response.output;
        await rows(1);

        const second = await respond(unityToolRoundBody("avatar-default", output, true), {
          "X-Session-Id": sessionId,
        });
        expect(second.status).toBe(200);
        expect(second.headers.get(SESSION_HEADER)).toBe(sessionId);
        expect(readUnityStream(await second.text()).text).toBe("Done! I put the image on screen.");
        await rows(2);

        const [session] = await getDb().select().from(sessions).where(eq(sessions.id, sessionId));
        expect(session.turnCount).toBe(1);
        const stored = await items(sessionId);
        expect(stored.map((item) => item.kind)).toEqual([
          "system_prompt",
          "user_message",
          "assistant_message",
          "tool_call",
          "tool_result",
          "assistant_message",
        ]);
        const call = stored.find((item) => item.kind === "tool_call");
        const result = stored.find((item) => item.kind === "tool_result");
        expect(result).toMatchObject({
          toolCallId: call?.toolCallId,
          toolName: "show_image",
          content: '{"shown":true}',
        });
        expect(new Set(stored.map((item) => item.turnId)).size).toBe(1);
      });
    },
  );

  describe("session contract and routing", () => {
    it("returns 404 session_not_found for an unknown session id", async () => {
      await route("avatar-default", "native", "ok");
      const response = await respond(
        { model: "avatar-default", input: "hi" },
        { "X-Session-Id": "00000000-0000-4000-8000-000000000000" },
      );
      expect(response.status).toBe(404);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
        "session_not_found",
      );
    });

    it("returns 404 after an admin ended the session, and a new id when retried", async () => {
      await route("avatar-default", "chat", "ok");
      const first = await respond({ model: "avatar-default", input: "hi" });
      const sessionId = first.headers.get(SESSION_HEADER) as string;
      await rows(1);
      const ended = await admin.request(`/api/admin/sessions/${sessionId}/end`, {
        method: "POST",
        headers: adminHeaders(),
      });
      expect(ended.status).toBe(200);
      const again = await respond(
        { model: "avatar-default", input: "hi" },
        { "X-Session-Id": sessionId },
      );
      expect(again.status).toBe(404);
      const retry = await respond({ model: "avatar-default", input: "hi" });
      expect(retry.status).toBe(200);
      expect(retry.headers.get(SESSION_HEADER)).not.toBe(sessionId);
    });

    it("uses the default route when model is absent or 'default', and 400s for unknown models", async () => {
      await route("avatar-default", "native", "ok");
      for (const model of [undefined, "default"]) {
        const response = await respond({ ...(model ? { model } : {}), input: "hi" });
        expect(response.status).toBe(200);
      }
      const unknown = await respond({ model: "nope", input: "hi" });
      expect(unknown.status).toBe(400);
      expect(((await unknown.json()) as { error: { code: string } }).error.code).toBe(
        "model_not_found",
      );
    });

    it("validates the body and requires authentication", async () => {
      await route("avatar-default", "native", "ok");
      const missing = await respond({ model: "avatar-default" });
      expect(missing.status).toBe(400);
      expect(((await missing.json()) as { error: { message: string } }).error.message).toContain(
        "input",
      );
      const unauthenticated = await app.request("/v1/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: "hi" }),
      });
      expect(unauthenticated.status).toBe(401);
    });

    it("enforces the request rate limit like chat completions", async () => {
      await route("avatar-default", "native", "ok");
      const limited = await seedApiKey({ rpm_limit: 1 });
      const send = () =>
        app.request("/v1/responses", {
          method: "POST",
          headers: { Authorization: `Bearer ${limited.key}`, "Content-Type": "application/json" },
          body: JSON.stringify({ input: "hi" }),
        });
      expect((await send()).status).toBe(200);
      expect((await send()).status).toBe(429);
    });
  });

  describe("transcripts and logging", () => {
    it("shows Responses turns like chat turns: reasoning, answer, grouped turns", async () => {
      await route("avatar-default", "chat", "reasoning");
      const first = await respond({
        model: "avatar-default",
        instructions: "Be kind.",
        input: [{ role: "user", content: "Hello!" }],
        stream: true,
      });
      const sessionId = first.headers.get(SESSION_HEADER) as string;
      await first.text();
      await rows(1);
      const second = await respond(
        {
          model: "avatar-default",
          instructions: "Be kind.",
          input: [
            { role: "user", content: "Hello!" },
            { role: "assistant", content: "Hello from the reasoning model." },
            { role: "user", content: "And again?" },
          ],
          stream: true,
        },
        { "X-Session-Id": sessionId },
      );
      await second.text();
      await rows(2);

      const stored = await items(sessionId);
      expect(stored.map((item) => [item.kind, item.content])).toEqual([
        ["system_prompt", "Be kind."],
        ["user_message", "Hello!"],
        ["reasoning", "The user greets me. I should answer warmly."],
        ["assistant_message", "Hello from the reasoning model."],
        ["user_message", "And again?"],
        ["reasoning", "The user greets me. I should answer warmly."],
        ["assistant_message", "Hello from the reasoning model."],
      ]);
      const [session] = await getDb().select().from(sessions).where(eq(sessions.id, sessionId));
      expect(session.turnCount).toBe(2);

      const detail = await admin.request(`/api/admin/sessions/${sessionId}`, {
        headers: adminHeaders(),
      });
      const json = (await detail.json()) as {
        turns: { requests: { client_api: string; upstream_api: string }[] }[];
      };
      expect(json.turns[0].requests[0]).toMatchObject({
        client_api: "responses",
        upstream_api: "chat",
      });
    });

    it("records client and upstream API on llm_requests, including for chat completions", async () => {
      await route("avatar-default", "native", "ok");
      await respond({ model: "avatar-default", input: "hi" });
      await app.request("/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "avatar-default",
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      const found = await rows(2);
      expect(found.map((row) => [row.clientApi, row.upstreamApi])).toEqual([
        ["responses", "responses"],
        ["chat", "chat"],
      ]);
      expect(found[0].apiKeyId).toBe(keyId);
    });

    it("keeps message content out of request rows and logs", async () => {
      process.env.LOG_LEVEL = "debug";
      const lines: string[] = [];
      const capture = (...args: unknown[]) => {
        lines.push(args.map(String).join(" "));
      };
      vi.spyOn(console, "log").mockImplementation(capture);
      vi.spyOn(console, "error").mockImplementation(capture);
      try {
        await route("avatar-default", "chat", "echo");
        const response = await respond({
          model: "avatar-default",
          instructions: "secret instructions text",
          input: "secret user prompt text",
          stream: true,
        });
        await response.text();
        const [row] = await rows(1);
        const serialized = JSON.stringify(row);
        for (const secret of ["secret user prompt", "secret instructions", "Echo:"]) {
          expect(serialized).not.toContain(secret);
          expect(lines.join("\n")).not.toContain(secret);
        }
        await waitFor(async () =>
          lines.some((line) => line.includes('"response"')) ? true : undefined,
        );
      } finally {
        process.env.LOG_LEVEL = "error";
      }
    });

    it("orders newest rows first when listing (sanity for the helper)", async () => {
      await route("avatar-default", "native", "ok");
      await respond({ model: "avatar-default", input: "hi" });
      await rows(1);
      const newest = await getDb().select().from(llmRequests).orderBy(desc(llmRequests.startedAt));
      expect(newest).toHaveLength(1);
    });
  });
});
