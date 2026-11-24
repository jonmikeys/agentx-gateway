import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { BUILTIN_TOOL_NAMES, type BuiltinToolName } from "@/lib/builtin-tools";
import { createAdminApp } from "@/server/api/admin-app";
import { createApiApp } from "@/server/api/app";
import { closeDatabase } from "@/server/db/client";
import { resetEnvCacheForTests } from "@/server/env";
import { setTestAllowedAddresses } from "@/server/net/public-fetch";
import { findSessionDetail } from "@/server/services/session-queries";
import { setYtDlpForTests } from "@/server/tools/builtin/video-resolver";
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

const articleHtml = `<html><head><title>Red pandas</title></head><body><nav>Menu</nav><article>
  <h1>All about red pandas</h1>${Array.from(
    { length: 10 },
    (_, index) =>
      `<p>Paragraph ${index}: red pandas live in the eastern Himalayas and eat mostly bamboo leaves.</p>`,
  ).join("")}</article><script>tracker()</script></body></html>`;

const longHtml = `<html><head><title>Long</title></head><body><article>${Array.from(
  { length: 400 },
  (_, index) => `<p>Long paragraph number ${index} with a few more words to make it longer.</p>`,
).join("")}</article></body></html>`;

/** Local pages for read_web_page (127.0.0.1 is allowed for tests only). */
async function startPageServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((request, response) => {
    const path = request.url ?? "/";
    const html = (body: string) => {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(body);
    };
    if (path === "/article") return html(articleHtml);
    if (path === "/long") return html(longHtml);
    if (path === "/js") {
      return html('<html><body><div id="app"></div><script>boot()</script></body></html>');
    }
    if (path === "/redirect") {
      response.writeHead(302, { Location: "/article" });
      return response.end();
    }
    if (path === "/redirect-private") {
      response.writeHead(302, { Location: "http://10.255.255.1/secret" });
      return response.end();
    }
    if (path === "/text") {
      response.writeHead(200, { "Content-Type": "text/plain" });
      return response.end("plain   text\n\nsecond paragraph");
    }
    if (path === "/pdf") {
      response.writeHead(200, { "Content-Type": "application/pdf" });
      return response.end("%PDF-1.4");
    }
    if (path === "/big") {
      response.writeHead(200, { "Content-Type": "text/html" });
      return response.end(`<html><body><p>${"big ".repeat(800_000)}</p></body></html>`);
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

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
    setYtDlpForTests({ available: true });
  });

  afterAll(async () => {
    setSearchEnv(undefined);
    setYtDlpForTests(undefined);
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

  function searchRoute(builtinTools: BuiltinToolName[] = ["web_search", "read_web_page"]) {
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
    expect(offered.map((tool) => tool.function.name)).toEqual([
      "show_image",
      "web_search",
      "read_web_page",
    ]);
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

  describe("read_web_page", () => {
    let pages: Awaited<ReturnType<typeof startPageServer>>;

    beforeAll(async () => {
      pages = await startPageServer();
    });

    afterAll(async () => {
      setTestAllowedAddresses([]);
      await pages.close();
    });

    beforeEach(async () => {
      setTestAllowedAddresses(["127.0.0.1"]);
      await searchRoute();
    });

    async function read(args: Record<string, unknown>) {
      const response = await chat({
        model: "search-route",
        messages: [{ role: "user", content: JSON.stringify({ tool: "read_web_page", args }) }],
      });
      const text = (await response.json()).choices[0].message.content as string;
      const payload = text.slice("Result: ".length);
      return payload.startsWith("Error:")
        ? payload
        : (JSON.parse(payload) as Record<string, unknown>);
    }

    it("returns the main text of a page, following redirects", async () => {
      const page = (await read({ url: `${pages.url}/redirect` })) as Record<string, unknown>;
      expect(page.url).toBe(`${pages.url}/article`);
      expect(page.title).toBe("Red pandas");
      expect(page.content).toContain("Paragraph 0: red pandas live");
      expect(page.content).not.toContain("tracker");
      expect(page.next_offset).toBeNull();
    });

    it("pages long text with offset", async () => {
      const first = (await read({ url: `${pages.url}/long` })) as Record<string, unknown>;
      expect((first.content as string).length).toBeLessThanOrEqual(8000);
      expect(first.next_offset).toEqual(expect.any(Number));
      const second = (await read({
        url: `${pages.url}/long`,
        offset: first.next_offset,
      })) as Record<string, unknown>;
      expect(second.offset).toBe(first.next_offset);
      expect(second.content).not.toEqual(first.content);
    });

    it("says so when a page has no text without JavaScript", async () => {
      const page = (await read({ url: `${pages.url}/js` })) as Record<string, unknown>;
      expect(page.content).toBe("");
      expect(page.note).toContain("JavaScript");
    });

    it("reads plain text and caps downloads at 2 MB", async () => {
      const text = (await read({ url: `${pages.url}/text` })) as Record<string, unknown>;
      expect(text.content).toBe("plain text\n\nsecond paragraph");
      const big = (await read({ url: `${pages.url}/big` })) as Record<string, unknown>;
      expect(big.note).toContain("2 MB");
    });

    it("refuses private addresses, also after a redirect, and non-pages", async () => {
      const blocked = "Error: Private network addresses cannot be opened.";
      expect(await read({ url: `${pages.url}/redirect-private` })).toBe(blocked);
      expect(await read({ url: "http://169.254.169.254/latest/meta-data/" })).toBe(blocked);
      setTestAllowedAddresses([]);
      expect(await read({ url: `${pages.url}/article` })).toBe(blocked);
      setTestAllowedAddresses(["127.0.0.1"]);
      expect(await read({ url: `${pages.url}/pdf` })).toContain("application/pdf file");
      expect(await read({ url: `${pages.url}/missing` })).toBe(
        "Error: the page answered HTTP 404.",
      );
      expect(await read({ url: "file:///etc/passwd" })).toContain("invalid arguments");
    });
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
      expect(ok.data.map((tool: { name: string }) => tool.name)).toEqual([...BUILTIN_TOOL_NAMES]);
      expect(ok.data.every((tool: { available: boolean }) => tool.available)).toBe(true);
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
