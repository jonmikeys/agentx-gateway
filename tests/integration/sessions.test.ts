import { asc, eq, sql } from "drizzle-orm";
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
import { llmRequests, sessions, transcriptItems, turns } from "@/server/db/schema";
import { getDashboardStats } from "@/server/services/dashboard";
import {
  clearPurgeHooksForTests,
  registerPurgeHook,
  runMaintenance,
} from "@/server/services/session-maintenance";
import { updateSessionSettings } from "@/server/services/session-settings";
import { resolveSession } from "@/server/services/sessions";
import { type MockUpstream, startMockUpstream } from "../support/mock-upstream";
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

describe("sessions and transcripts", () => {
  const app = createApiApp();
  const admin = createAdminApp();
  let upstream: MockUpstream;
  let key: string;
  let keyId: string;
  let providerId: string;

  beforeAll(async () => {
    await prepareDatabase(databaseUrl);
    upstream = await startMockUpstream();
  });

  afterAll(async () => {
    await upstream.close();
    await closeDatabase();
  });

  beforeEach(async () => {
    await resetGatewayState();
    upstream.reset();
    clearPurgeHooksForTests();
    providerId = (await seedProvider("Alpha", upstream.url)).id;
    for (const model of ["ok", "reasoning", "think-tags", "tool-call", "echo"]) {
      await seedRoute(model, [{ providerId, model }]);
    }
    const created = await seedApiKey();
    key = created.key;
    keyId = created.apiKey.id;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function chat(body: Record<string, unknown>, headers: Record<string, string> = {}) {
    return app.request("/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  }

  const adminCall = (path: string, method = "GET", body?: unknown) =>
    admin.request(`/api/admin/${path}`, {
      method,
      headers: adminHeaders(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  /** Sends one turn and returns the session id after the body was fully read. */
  async function say(
    model: string,
    messages: unknown[],
    sessionId?: string,
    extra: Record<string, unknown> = {},
  ) {
    const response = await chat(
      { model, messages, stream: true, ...extra },
      sessionId ? { "X-Session-Id": sessionId } : {},
    );
    const text = await response.text();
    return { response, text, id: response.headers.get(SESSION_HEADER) ?? "" };
  }

  /** Waits until the request row for the n-th request of a session exists (written after the stream). */
  async function waitForRequests(sessionId: string, count: number) {
    await waitFor(async () => {
      const rows = await getDb()
        .select({ id: llmRequests.id })
        .from(llmRequests)
        .where(eq(llmRequests.sessionId, sessionId));
      return rows.length >= count ? rows : undefined;
    });
  }

  async function items(sessionId: string) {
    return getDb()
      .select()
      .from(transcriptItems)
      .where(eq(transcriptItems.sessionId, sessionId))
      .orderBy(asc(transcriptItems.seq));
  }

  async function backdate(sessionId: string, minutes: number) {
    await getDb()
      .update(sessions)
      .set({ lastActivityAt: new Date(Date.now() - minutes * 60_000) })
      .where(eq(sessions.id, sessionId));
  }

  const system = { role: "system", content: "You are an avatar." };

  describe("session contract", () => {
    it("creates a session and returns X-Session-Id on JSON responses", async () => {
      const response = await chat({ model: "ok", messages: [{ role: "user", content: "Hi" }] });
      expect(response.status).toBe(200);
      expect(response.headers.get(SESSION_HEADER)).toMatch(/^[0-9a-f-]{36}$/);
      await response.text();
    });

    it("has X-Session-Id in the response head before the first SSE event", async () => {
      const response = await chat({
        model: "ok",
        stream: true,
        messages: [{ role: "user", content: "Hi" }],
      });
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      const id = response.headers.get(SESSION_HEADER);
      expect(id).toBeTruthy();
      // Nothing of the body has been read yet: the header travelled with the response head.
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toContain("data:");
      await reader.cancel();
    });

    it("continues a session with the same id", async () => {
      const first = await say("ok", [system, { role: "user", content: "Hi" }]);
      const second = await say(
        "ok",
        [
          system,
          { role: "user", content: "Hi" },
          { role: "assistant", content: "Hello there" },
          { role: "user", content: "Again" },
        ],
        first.id,
      );
      expect(second.id).toBe(first.id);
      expect(second.response.status).toBe(200);
    });

    it("answers an unknown session id with 404 session_not_found", async () => {
      const response = await chat(
        { model: "ok", messages: [{ role: "user", content: "Hi" }] },
        { "X-Session-Id": crypto.randomUUID() },
      );
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        error: {
          message: "Session is unknown or expired.",
          type: "invalid_request_error",
          code: "session_not_found",
        },
      });
      const garbage = await chat(
        { model: "ok", messages: [{ role: "user", content: "Hi" }] },
        { "X-Session-Id": "not-a-uuid" },
      );
      expect(garbage.status).toBe(404);
    });

    it("does not let another API key use a session", async () => {
      const first = await say("ok", [{ role: "user", content: "Hi" }]);
      const other = await seedApiKey();
      const response = await app.request("/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${other.key}`,
          "Content-Type": "application/json",
          "X-Session-Id": first.id,
        },
        body: JSON.stringify({ model: "ok", messages: [{ role: "user", content: "Hi" }] }),
      });
      expect(response.status).toBe(404);
    });

    it("expires sessions idle beyond the timeout lazily", async () => {
      await updateSessionSettings({
        idle_timeout_minutes: 1,
        retention_days: 90,
        redaction_enabled: false,
      });
      const first = await say("ok", [{ role: "user", content: "Hi" }]);
      await waitForRequests(first.id, 1);
      await backdate(first.id, 5);
      const response = await chat(
        { model: "ok", messages: [{ role: "user", content: "Hi" }] },
        { "X-Session-Id": first.id },
      );
      expect(response.status).toBe(404);
      const [row] = await getDb().select().from(sessions).where(eq(sessions.id, first.id));
      expect(row).toMatchObject({ status: "expired", endReason: "idle" });
    });

    it("answers 404 after an admin ends the session", async () => {
      const first = await say("ok", [{ role: "user", content: "Hi" }]);
      await waitForRequests(first.id, 1);
      const ended = await adminCall(`sessions/${first.id}/end`, "POST");
      expect(ended.status).toBe(200);
      expect(await ended.json()).toMatchObject({ status: "ended", end_reason: "admin" });
      expect((await adminCall(`sessions/${first.id}/end`, "POST")).status).toBe(409);
      const response = await chat(
        { model: "ok", messages: [{ role: "user", content: "Hi" }] },
        { "X-Session-Id": first.id },
      );
      expect(response.status).toBe(404);
    });

    describe("POST /v1/sessions/{id}/end", () => {
      const endCall = (id: string, bearer = key) =>
        app.request(`/v1/sessions/${id}/end`, {
          method: "POST",
          headers: { Authorization: `Bearer ${bearer}` },
        });
      const rowOf = async (id: string) =>
        (await getDb().select().from(sessions).where(eq(sessions.id, id)))[0];

      it("ends the caller's active session, so the next request gets session_not_found", async () => {
        const first = await say("ok", [{ role: "user", content: "Hi" }]);
        await waitForRequests(first.id, 1);

        const response = await endCall(first.id);
        expect(response.status).toBe(204);
        expect(await response.text()).toBe("");
        expect(await rowOf(first.id)).toMatchObject({ status: "ended", endReason: "client" });

        const next = await chat(
          { model: "ok", messages: [{ role: "user", content: "Hi" }] },
          { "X-Session-Id": first.id },
        );
        expect(next.status).toBe(404);
        expect((await next.json()).error.code).toBe("session_not_found");
      });

      it("is idempotent and keeps the first end reason and time", async () => {
        const first = await say("ok", [{ role: "user", content: "Hi" }]);
        await waitForRequests(first.id, 1);
        expect((await endCall(first.id)).status).toBe(204);
        const endedAt = (await rowOf(first.id))?.endedAt;
        expect((await endCall(first.id)).status).toBe(204);
        expect((await rowOf(first.id))?.endedAt).toEqual(endedAt);
      });

      it("leaves an admin-ended or expired session as it was", async () => {
        const admined = await say("ok", [{ role: "user", content: "Hi" }]);
        await waitForRequests(admined.id, 1);
        await adminCall(`sessions/${admined.id}/end`, "POST");
        expect((await endCall(admined.id)).status).toBe(204);
        expect(await rowOf(admined.id)).toMatchObject({ status: "ended", endReason: "admin" });
      });

      it("answers 204 for unknown and malformed ids", async () => {
        expect((await endCall("00000000-0000-4000-8000-000000000000")).status).toBe(204);
        expect((await endCall("not-a-uuid")).status).toBe(204);
      });

      it("does not end a session owned by another API key", async () => {
        const first = await say("ok", [{ role: "user", content: "Hi" }]);
        await waitForRequests(first.id, 1);
        const other = await seedApiKey();
        expect((await endCall(first.id, other.key)).status).toBe(204);
        expect(await rowOf(first.id)).toMatchObject({ status: "active", endReason: null });
      });

      it("requires a valid API key", async () => {
        const first = await say("ok", [{ role: "user", content: "Hi" }]);
        await waitForRequests(first.id, 1);
        expect((await endCall(first.id, "wrong-key")).status).toBe(401);
        expect(await rowOf(first.id)).toMatchObject({ status: "active" });
      });
    });

    it("never requires or reads the header on GET /v1/models", async () => {
      const response = await app.request("/v1/models", {
        headers: { Authorization: `Bearer ${key}`, "X-Session-Id": "garbage" },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get(SESSION_HEADER)).toBeNull();
    });

    it("ends the session and returns a new id when the agent changes (G7a hook)", async () => {
      const first = await resolveSession({
        headerValue: undefined,
        apiKeyId: keyId,
        routeSlug: "ok",
        agentId: "agt_a",
      });
      expect(first?.isNew).toBe(true);
      const same = await resolveSession({
        headerValue: first?.sessionId,
        apiKeyId: keyId,
        routeSlug: "ok",
        agentId: "agt_a",
      });
      expect(same).toEqual({ sessionId: first?.sessionId, isNew: false });
      const switched = await resolveSession({
        headerValue: first?.sessionId,
        apiKeyId: keyId,
        routeSlug: "ok",
        agentId: "agt_b",
      });
      expect(switched?.isNew).toBe(true);
      expect(switched?.sessionId).not.toBe(first?.sessionId);
      const [old] = await getDb()
        .select()
        .from(sessions)
        .where(eq(sessions.id, first?.sessionId ?? ""));
      expect(old).toMatchObject({ status: "ended", endReason: "agent_changed" });
    });
  });

  describe("transcript capture", () => {
    it("stores each message exactly once across a 3-turn conversation with full history", async () => {
      const history: unknown[] = [system];
      let sessionId: string | undefined;
      for (const text of ["First question", "Second question", "Third question"]) {
        history.push({ role: "user", content: text });
        const result = await say("echo", [...history], sessionId);
        sessionId = result.id;
        history.push({ role: "assistant", content: `Echo: ${text}` });
      }
      const id = sessionId ?? "";
      await waitForRequests(id, 3);

      const stored = await items(id);
      expect(stored.map((item) => [item.kind, item.content])).toEqual([
        ["system_prompt", "You are an avatar."],
        ["user_message", "First question"],
        ["assistant_message", "Echo: First question"],
        ["user_message", "Second question"],
        ["assistant_message", "Echo: Second question"],
        ["user_message", "Third question"],
        ["assistant_message", "Echo: Third question"],
      ]);
      const [session] = await getDb().select().from(sessions).where(eq(sessions.id, id));
      expect(session.turnCount).toBe(3);
      const turnRows = await getDb().select().from(turns).where(eq(turns.sessionId, id));
      expect(turnRows).toHaveLength(3);
      const requestRows = await getDb()
        .select()
        .from(llmRequests)
        .where(eq(llmRequests.sessionId, id));
      expect(requestRows).toHaveLength(3);
      expect(requestRows.every((row) => row.turnId !== null)).toBe(true);
    });

    it("stores the system prompt again only when it changes", async () => {
      const first = await say("ok", [system, { role: "user", content: "a" }]);
      await waitForRequests(first.id, 1);
      await say(
        "ok",
        [
          system,
          { role: "user", content: "a" },
          { role: "assistant", content: "Hello there" },
          { role: "user", content: "b" },
        ],
        first.id,
      );
      await waitForRequests(first.id, 2);
      await say(
        "ok",
        [
          { role: "system", content: "A different prompt." },
          { role: "user", content: "a" },
          { role: "assistant", content: "Hello there" },
          { role: "user", content: "b" },
          { role: "assistant", content: "Hello there" },
          { role: "user", content: "c" },
        ],
        first.id,
      );
      await waitForRequests(first.id, 3);
      const prompts = (await items(first.id)).filter((item) => item.kind === "system_prompt");
      expect(prompts.map((item) => item.content)).toEqual([
        "You are an avatar.",
        "A different prompt.",
      ]);
    });

    it("appends a client tool round to the same turn and links the result to the call", async () => {
      const first = await say("tool-call", [system, { role: "user", content: "Show a sunset" }]);
      expect(first.text).toContain("show_image");
      await waitForRequests(first.id, 1);
      const callItem = (await items(first.id)).find((item) => item.kind === "tool_call");
      expect(callItem).toMatchObject({
        toolName: "show_image",
        toolCallId: "call_mock_1",
        toolSource: "client",
        toolArgs: { media_id: "sunset" },
      });

      await say(
        "tool-call",
        [
          system,
          { role: "user", content: "Show a sunset" },
          {
            role: "assistant",
            content: "Let me show that. ",
            tool_calls: [
              {
                id: "call_mock_1",
                type: "function",
                function: { name: "show_image", arguments: '{"media_id":"sunset"}' },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_mock_1", content: "Image shown" },
        ],
        first.id,
      );
      await waitForRequests(first.id, 2);

      const stored = await items(first.id);
      expect(stored.map((item) => item.kind)).toEqual([
        "system_prompt",
        "user_message",
        "assistant_message",
        "tool_call",
        "tool_result",
        "assistant_message",
      ]);
      const result = stored.find((item) => item.kind === "tool_result");
      expect(result).toMatchObject({
        toolCallId: "call_mock_1",
        toolName: "show_image",
        content: "Image shown",
      });
      expect(new Set(stored.map((item) => item.turnId)).size).toBe(1);
      const [session] = await getDb().select().from(sessions).where(eq(sessions.id, first.id));
      expect(session.turnCount).toBe(1);
    });

    it("stores reasoning separately from assistant text (reasoning fields and think tags)", async () => {
      const viaField = await say("reasoning", [{ role: "user", content: "Hi" }]);
      await waitForRequests(viaField.id, 1);
      const fieldItems = await items(viaField.id);
      expect(fieldItems.find((item) => item.kind === "reasoning")?.content).toBe(
        "The user greets me. I should answer warmly.",
      );
      expect(fieldItems.find((item) => item.kind === "assistant_message")?.content).toBe(
        "Hello from the reasoning model.",
      );

      const viaTags = await say("think-tags", [{ role: "user", content: "Hi" }]);
      await waitForRequests(viaTags.id, 1);
      const tagItems = await items(viaTags.id);
      expect(tagItems.find((item) => item.kind === "reasoning")?.content).toBe(
        "Considering the request carefully.",
      );
      const answer = tagItems.find((item) => item.kind === "assistant_message")?.content;
      expect(answer).toBe("Here is my considered answer.");
      expect(answer).not.toContain("think");
    });

    it("captures non-streamed responses too", async () => {
      const response = await chat({
        model: "reasoning",
        messages: [{ role: "user", content: "Hi" }],
      });
      const id = response.headers.get(SESSION_HEADER) ?? "";
      await response.text();
      await waitForRequests(id, 1);
      const kinds = (await items(id)).map((item) => item.kind);
      expect(kinds).toEqual(["user_message", "reasoning", "assistant_message"]);
    });

    it("stores an upstream failure as an error item", async () => {
      await seedRoute("broken", [{ providerId, model: "fail-503" }]);
      const response = await chat({ model: "broken", messages: [{ role: "user", content: "Hi" }] });
      expect(response.status).toBe(502);
      expect(response.headers.get(SESSION_HEADER)).toBeTruthy();
      const id = response.headers.get(SESSION_HEADER) ?? "";
      await waitForRequests(id, 1);
      const stored = await items(id);
      expect(stored.map((item) => item.kind)).toEqual(["user_message", "error"]);
      expect(stored[1].content).toContain("all_providers_failed");
    });

    it("redacts emails and phone numbers only when enabled", async () => {
      const text = "Mail jane@example.com or call +1 555 123 4567";
      const plain = await say("echo", [{ role: "user", content: text }]);
      await waitForRequests(plain.id, 1);
      expect((await items(plain.id)).map((item) => item.content)).toEqual([text, `Echo: ${text}`]);

      await updateSessionSettings({
        idle_timeout_minutes: 30,
        retention_days: 90,
        redaction_enabled: true,
      });
      const masked = await say("echo", [{ role: "user", content: text }]);
      await waitForRequests(masked.id, 1);
      expect((await items(masked.id)).map((item) => item.content)).toEqual([
        "Mail [email] or call [phone]",
        "Echo: Mail jane@example.com or call +1 555 123 4567"
          .replace("jane@example.com", "[email]")
          .replace("+1 555 123 4567", "[phone]"),
      ]);
    });

    it("never logs transcript text", async () => {
      process.env.LOG_LEVEL = "debug";
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const secret = "zebra-quartz-secret-prompt";
        const result = await say("echo", [system, { role: "user", content: secret }]);
        await waitForRequests(result.id, 1);
        await adminCall(`sessions/${result.id}`);
        const logged = [...log.mock.calls, ...error.mock.calls].flat().join("\n");
        expect(logged).not.toContain(secret);
        expect(logged).not.toContain("You are an avatar.");
        expect(logged).toContain("chat completion");
      } finally {
        process.env.LOG_LEVEL = "error";
      }
    });
  });

  describe("maintenance", () => {
    it("flags one-request expired sessions as standalone and leaves conversations alone", async () => {
      const oneShot = await say("ok", [{ role: "user", content: "Title this" }]);
      const chatSession = await say("ok", [{ role: "user", content: "a" }]);
      await waitForRequests(chatSession.id, 1);
      await say(
        "ok",
        [
          { role: "user", content: "a" },
          { role: "assistant", content: "Hello there" },
          { role: "user", content: "b" },
        ],
        chatSession.id,
      );
      await waitForRequests(oneShot.id, 1);
      await waitForRequests(chatSession.id, 2);
      await backdate(oneShot.id, 45);
      await backdate(chatSession.id, 45);

      const result = await runMaintenance();
      expect(result).toMatchObject({ expired: 2, standalone: 1 });
      const rows = await getDb().select().from(sessions);
      const byId = new Map(rows.map((row) => [row.id, row]));
      expect(byId.get(oneShot.id)).toMatchObject({ status: "expired", standalone: true });
      expect(byId.get(chatSession.id)).toMatchObject({ status: "expired", standalone: false });

      const listed = await (await adminCall("sessions")).json();
      expect(listed.data.map((row: { id: string }) => row.id)).toEqual([chatSession.id]);
      const withStandalone = await (await adminCall("sessions?include_standalone=true")).json();
      expect(withStandalone.total).toBe(2);
    });

    it("purges sessions past retention, cascades, and runs purge hooks", async () => {
      await updateSessionSettings({
        idle_timeout_minutes: 30,
        retention_days: 10,
        redaction_enabled: false,
      });
      const hook = vi.fn(async () => {});
      registerPurgeHook("test-memory", hook);
      const old = await say("ok", [{ role: "user", content: "old" }]);
      const fresh = await say("ok", [{ role: "user", content: "fresh" }]);
      await waitForRequests(old.id, 1);
      await waitForRequests(fresh.id, 1);
      await backdate(old.id, 11 * 24 * 60);

      const result = await runMaintenance();
      expect(result.purged).toBe(1);
      expect(hook).toHaveBeenCalledWith([old.id]);
      expect(await items(old.id)).toHaveLength(0);
      expect(
        await getDb().select().from(llmRequests).where(eq(llmRequests.sessionId, old.id)),
      ).toHaveLength(0);
      expect(await items(fresh.id)).toHaveLength(2);
    });

    it("keeps everything when retention is 0", async () => {
      await updateSessionSettings({
        idle_timeout_minutes: 30,
        retention_days: 0,
        redaction_enabled: false,
      });
      const old = await say("ok", [{ role: "user", content: "old" }]);
      await waitForRequests(old.id, 1);
      await backdate(old.id, 400 * 24 * 60);
      expect((await runMaintenance()).purged).toBe(0);
    });
  });

  describe("admin API", () => {
    async function seedConversation(label: string, model = "echo") {
      const result = await say(model, [system, { role: "user", content: label }]);
      await waitForRequests(result.id, 1);
      return result.id;
    }

    it("deletes one session, and by date range and filters", async () => {
      const a = await seedConversation("alpha topic");
      const b = await seedConversation("beta topic");
      const c = await seedConversation("gamma topic");
      await getDb()
        .update(sessions)
        .set({ startedAt: new Date("2025-01-10T12:00:00Z") })
        .where(eq(sessions.id, a));
      await getDb()
        .update(sessions)
        .set({ startedAt: new Date("2025-01-20T12:00:00Z") })
        .where(eq(sessions.id, b));

      expect((await adminCall(`sessions/${c}`, "DELETE")).status).toBe(204);
      expect((await adminCall(`sessions/${c}`, "DELETE")).status).toBe(404);

      const bulk = await adminCall("sessions/bulk-delete", "POST", {
        filters: { from: "2025-01-01T00:00:00Z", to: "2025-01-15T00:00:00Z" },
      });
      expect(await bulk.json()).toEqual({ deleted: 1 });
      const remaining = await getDb().select({ id: sessions.id }).from(sessions);
      expect(remaining.map((row) => row.id)).toEqual([b]);

      const byIds = await adminCall("sessions/bulk-delete", "POST", { ids: [b] });
      expect(await byIds.json()).toEqual({ deleted: 1 });
      expect((await adminCall("sessions/bulk-delete", "POST", {})).status).toBe(400);
      const leftoverItems = await getDb()
        .select({ n: sql<number>`count(*)::int` })
        .from(transcriptItems);
      expect(leftoverItems[0].n).toBe(0);
    });

    it("lists with pagination, sorting and filters, and searches full text", async () => {
      const ids = [];
      for (const topic of ["pineapple pizza", "quantum physics", "pineapple juice"]) {
        ids.push(await seedConversation(topic));
      }
      const page = await (await adminCall("sessions?page_size=2&sort=started_at&dir=asc")).json();
      expect(page).toMatchObject({ total: 3, page: 1, page_size: 2 });
      expect(page.data.map((row: { id: string }) => row.id)).toEqual(ids.slice(0, 2));
      expect(page.data[0].api_key_label).toBe("test");

      const search = await (await adminCall("sessions?q=pineapple")).json();
      expect(search.total).toBe(2);
      const phrase = await (
        await adminCall(`sessions?q=${encodeURIComponent('"quantum physics"')}`)
      ).json();
      expect(phrase.data.map((row: { id: string }) => row.id)).toEqual([ids[1]]);
      expect((await (await adminCall("sessions?q=nonexistentword")).json()).total).toBe(0);

      await adminCall(`sessions/${ids[0]}/end`, "POST");
      expect((await (await adminCall("sessions?status=ended")).json()).total).toBe(1);
      expect((await (await adminCall("sessions?route=echo")).json()).total).toBe(3);
      expect((await (await adminCall("sessions?route=other")).json()).total).toBe(0);
      expect((await adminCall("sessions?status=bogus")).status).toBe(400);
      expect((await adminCall("sessions?sort=drop_table")).status).toBe(400);
    });

    it("returns session detail with turns, items and linked requests", async () => {
      const id = await seedConversation("detail please");
      const detail = await (await adminCall(`sessions/${id}`)).json();
      expect(detail.turns).toHaveLength(1);
      expect(detail.turns[0].items.map((item: { kind: string }) => item.kind)).toEqual([
        "system_prompt",
        "user_message",
        "assistant_message",
      ]);
      expect(detail.turns[0].requests[0]).toMatchObject({
        provider_name: "Alpha",
        status: "ok",
        usage: { total_tokens: 8 },
      });
      expect(detail.turns[0].requests[0].attempts[0]).toMatchObject({ outcome: "ok" });
      expect((await adminCall(`sessions/${crypto.randomUUID()}`)).status).toBe(404);
      expect((await adminCall("sessions/not-a-uuid")).status).toBe(404);
    });

    it("exports a session as JSON and Markdown", async () => {
      const first = await say("tool-call", [system, { role: "user", content: "Show a sunset" }]);
      await waitForRequests(first.id, 1);
      const json = await adminCall(`sessions/${first.id}/export?format=json`);
      expect(json.headers.get("content-disposition")).toContain(`session-${first.id}.json`);
      const parsed = await json.json();
      expect(parsed.id).toBe(first.id);
      expect(
        parsed.turns[0].items.some((item: { kind: string }) => item.kind === "tool_call"),
      ).toBe(true);

      const markdown = await (await adminCall(`sessions/${first.id}/export?format=md`)).text();
      expect(markdown).toContain(`# Session ${first.id}`);
      expect(markdown).toContain("**User**\n\nShow a sunset");
      expect(markdown).toContain("**Tool call** `show_image` (Unity)");
    });

    it("bulk exports CSV and JSON with the list's filters", async () => {
      const a = await seedConversation("export alpha");
      await seedConversation("export beta");
      await adminCall(`sessions/${a}/end`, "POST");

      const csv = await adminCall("sessions/export?format=csv");
      expect(csv.headers.get("content-type")).toContain("text/csv");
      const lines = (await csv.text()).trim().split("\n");
      expect(lines[0]).toBe(
        "id,client_key,route,agent,status,end_reason,standalone,started_at,last_activity_at,ended_at,turns,requests,total_tokens",
      );
      expect(lines).toHaveLength(3);
      expect(lines.some((line) => line.startsWith(a) && line.includes(",ended,admin,"))).toBe(true);

      const filtered = await (await adminCall("sessions/export?format=csv&status=ended")).text();
      expect(filtered.trim().split("\n")).toHaveLength(2);

      const json = await (await adminCall("sessions/export?format=json&q=beta")).json();
      expect(json).toHaveLength(1);
      expect(
        json[0].turns[0].items.some((item: { content: string }) => item.content === "export beta"),
      ).toBe(true);

      const selected = await (await adminCall(`sessions/export?format=json&ids=${a}`)).json();
      expect(selected.map((row: { id: string }) => row.id)).toEqual([a]);
    });

    it("reads and updates settings with validation", async () => {
      expect(await (await adminCall("settings")).json()).toEqual({
        idle_timeout_minutes: 30,
        retention_days: 90,
        redaction_enabled: false,
      });
      const updated = await adminCall("settings", "PUT", {
        idle_timeout_minutes: 5,
        retention_days: 0,
        redaction_enabled: true,
      });
      expect(await updated.json()).toEqual({
        idle_timeout_minutes: 5,
        retention_days: 0,
        redaction_enabled: true,
      });
      expect(await (await adminCall("settings")).json()).toMatchObject({ idle_timeout_minutes: 5 });
      expect(
        (
          await adminCall("settings", "PUT", {
            idle_timeout_minutes: 0,
            retention_days: 0,
            redaction_enabled: true,
          })
        ).status,
      ).toBe(400);
    });

    it("computes dashboard stats", async () => {
      await seedRoute("failing-first", [
        { providerId, model: "fail-503" },
        { providerId, model: "ok" },
      ]);
      await seedConversation("one");
      const failover = await say("failing-first", [{ role: "user", content: "two" }]);
      await waitForRequests(failover.id, 1);
      const stats = await getDashboardStats();
      expect(stats).toMatchObject({
        active_sessions: 2,
        sessions_today: 2,
        turns_today: 2,
        tokens_today: 16,
      });
      expect(stats.per_day).toHaveLength(14);
      expect(stats.per_day.at(-1)).toMatchObject({
        sessions: 2,
        turns: 2,
        failovers: 1,
        errors: 0,
      });
      expect(stats.tokens_per_provider).toEqual([{ provider: "Alpha", tokens: 16 }]);
      expect(stats.slowest_providers[0]).toMatchObject({ provider: "Alpha", requests: 2 });

      const viaApi = await (await adminCall("dashboard")).json();
      expect(viaApi.sessions_today).toBe(2);
    });

    it("requires admin auth", async () => {
      const response = await admin.request("/api/admin/sessions");
      expect(response.status).toBe(401);
    });
  });
});
