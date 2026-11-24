import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { createAdminApp } from "@/server/api/admin-app";
import { createApiApp } from "@/server/api/app";
import { closeDatabase } from "@/server/db/client";
import { resetEnvCacheForTests } from "@/server/env";
import { findSessionDetail } from "@/server/services/session-queries";
import { type MockSearxng, startMockSearxng } from "../support/mock-searxng";
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

describe("built-in web search tools", () => {
  const app = createApiApp();
  const admin = createAdminApp();
  let upstream: MockUpstream;
  let searxng: MockSearxng;
  let key: string;
  let providerId: string;

  function setSearchEnv(url: string | undefined, safesearch?: string) {
    if (url) process.env.SEARXNG_URL = url;
    else delete process.env.SEARXNG_URL;
    if (safesearch) process.env.SEARCH_SAFESEARCH = safesearch;
    else delete process.env.SEARCH_SAFESEARCH;
    resetEnvCacheForTests();
  }

  beforeAll(async () => {
    await prepareDatabase(databaseUrl);
    upstream = await startMockUpstream();
    searxng = await startMockSearxng();
  });

  afterAll(async () => {
    setSearchEnv(undefined);
    await resetGatewayState();
    await upstream.close();
    await searxng.close();
    await closeDatabase();
  });

  beforeEach(async () => {
    setSearchEnv(searxng.url);
    await resetGatewayState();
    providerId = (await seedProvider("Mock", upstream.url)).id;
    key = (await seedApiKey()).key;
  });

  afterEach(() => {
    upstream.reset();
    searxng.reset();
  });

  function searchRoute(builtinTools: "web_search"[] = ["web_search"]) {
    return seedRoute(
      "search-route",
      [{ providerId, model: "gateway-tool" }],
      true,
      [],
      builtinTools,
    );
  }

  function chat(body: Record<string, unknown>) {
    return app.request("/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  const askSearch = (args: Record<string, unknown>) => [
    { role: "user", content: JSON.stringify({ tool: "web_search", args }) },
  ];

  it("runs web_search in the loop and answers with the results", async () => {
    await searchRoute();
    const response = await chat({
      model: "search-route",
      messages: askSearch({ query: "red panda" }),
      tools: [{ type: "function", function: { name: "show_image", parameters: {} } }],
    });
    expect(response.status).toBe(200);
    const json = await response.json();
    const text = json.choices[0].message.content as string;
    expect(text.startsWith("Result: ")).toBe(true);
    const results = JSON.parse(text.slice("Result: ".length)).results as { url: string }[];
    expect(results).toHaveLength(5);
    expect(results[0]).toEqual({
      title: "Red panda - Wikipedia",
      url: "https://en.wikipedia.org/wiki/Red_panda",
      snippet: expect.stringContaining("small mammal"),
    });
    // Duplicates and non-http results are dropped.
    expect(new Set(results.map((result) => result.url)).size).toBe(5);
    expect(searxng.searches).toEqual([
      { q: "red panda", categories: "general", safesearch: "1", format: "json" },
    ]);
    // The model saw the built-in tool next to the client's; the client never sees it.
    const offered = upstream.chatRequests()[0].body?.tools as { function: { name: string } }[];
    expect(offered.map((tool) => tool.function.name)).toEqual(["show_image", "web_search"]);
    expect(json.choices[0].message.tool_calls).toBeUndefined();
  });

  it("honours max_results and the deployment safe search", async () => {
    setSearchEnv(searxng.url, "2");
    await searchRoute();
    const response = await chat({
      model: "search-route",
      messages: askSearch({ query: "x", max_results: 10, safesearch: 0 }),
    });
    const text = (await response.json()).choices[0].message.content as string;
    expect(JSON.parse(text.slice("Result: ".length)).results).toHaveLength(10);
    expect(searxng.searches[0].safesearch).toBe("2");
  });

  it("feeds backend errors back to the model", async () => {
    searxng.failWith(500);
    await searchRoute();
    const response = await chat({ model: "search-route", messages: askSearch({ query: "x" }) });
    expect((await response.json()).choices[0].message.content).toBe(
      "Result: Error: The search backend failed (HTTP 500).",
    );
  });

  it("records built-in transcript items", async () => {
    await searchRoute();
    const response = await chat({ model: "search-route", messages: askSearch({ query: "x" }) });
    await response.text();
    const sessionId = response.headers.get("x-session-id") as string;
    const items = await waitFor(async () => {
      const detail = await findSessionDetail(sessionId);
      const found = detail?.turns.flatMap((turn) =>
        turn.items.filter((item) => item.tool_source === "builtin"),
      );
      return found && found.length >= 2 ? found : undefined;
    });
    expect(items.map((item) => [item.kind, item.tool_name])).toEqual([
      ["tool_call", "web_search"],
      ["tool_result", "web_search"],
    ]);
    expect(items[0].tool_args).toEqual({ query: "x" });
    expect(items[1].duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("works for Responses clients", async () => {
    await searchRoute();
    const response = await app.request("/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "search-route",
        input: [
          { role: "user", content: JSON.stringify({ tool: "web_search", args: { query: "x" } }) },
        ],
      }),
    });
    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).toContain("Red panda - Wikipedia");
  });

  it("is not offered when SEARXNG_URL is unset", async () => {
    setSearchEnv(undefined);
    await searchRoute();
    const response = await chat({ model: "search-route", messages: askSearch({ query: "x" }) });
    expect(response.status).toBe(200);
    const request = upstream.chatRequests()[0];
    expect(request.body?.tools).toBeUndefined();
    expect(searxng.searches).toHaveLength(0);
  });

  it("is not offered on routes that did not select it", async () => {
    await searchRoute([]);
    await chat({ model: "search-route", messages: askSearch({ query: "x" }) });
    expect(upstream.chatRequests()[0].body?.tools).toBeUndefined();
  });

  it("lets a client tool of the same name win", async () => {
    await searchRoute();
    const response = await chat({
      model: "search-route",
      messages: askSearch({ query: "x" }),
      tools: [{ type: "function", function: { name: "web_search", parameters: {} } }],
    });
    const json = await response.json();
    expect(json.choices[0].message.tool_calls[0].function.name).toBe("web_search");
    expect(searxng.searches).toHaveLength(0);
  });

  describe("admin API", () => {
    function adminRequest(path: string, init: RequestInit = {}) {
      return admin.request(`/api/admin${path}`, {
        ...init,
        headers: { ...adminHeaders(), "Content-Type": "application/json", ...init.headers },
      });
    }

    const routeBody = (builtinTools: unknown) => ({
      slug: "admin-search",
      steps: [{ provider_id: providerId, upstream_model: "ok", timeout_ms: 5000 }],
      builtin_tools: builtinTools,
    });

    it("lists built-in tools with their availability", async () => {
      const ok = await (await adminRequest("/builtin-tools")).json();
      expect(ok.data).toEqual([expect.objectContaining({ name: "web_search", available: true })]);
      setSearchEnv(undefined);
      const off = await (await adminRequest("/builtin-tools")).json();
      expect(off.data[0]).toMatchObject({ available: false });
    });

    it("stores the selection, off by default, and rejects unknown names", async () => {
      const created = await adminRequest("/routes", {
        method: "POST",
        body: JSON.stringify({ ...routeBody(undefined), builtin_tools: undefined }),
      });
      expect(created.status).toBe(201);
      const route = await created.json();
      expect(route.builtin_tools).toEqual([]);

      const updated = await adminRequest(`/routes/${route.id}`, {
        method: "PUT",
        body: JSON.stringify(routeBody(["web_search", "web_search"])),
      });
      expect((await updated.json()).builtin_tools).toEqual(["web_search"]);

      const rejected = await adminRequest(`/routes/${route.id}`, {
        method: "PUT",
        body: JSON.stringify(routeBody(["shell"])),
      });
      expect(rejected.status).toBe(400);
    });
  });
});
