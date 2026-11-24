import { describe, expect, it } from "vitest";
import { routeGatewayTools, routeHasGatewayTools } from "@/server/gateway/gateway-tools";
import { clientToolNames, mergeMcpTools } from "@/server/gateway/llm-proxy";
import { searchSearxng } from "@/server/search/searxng";
import {
  availableBuiltinTools,
  listBuiltinTools,
  runBuiltinTool,
} from "@/server/tools/builtin/registry";
import type { BuiltinToolContext } from "@/server/tools/builtin/types";
import { clip } from "@/server/tools/builtin/web-search";

const search = { url: "http://searxng.test:8080", safesearch: 1 as const };

function jsonFetch(body: unknown, status = 200, seen: URL[] = []): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    seen.push(new URL(String(input)));
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

function context(fetchImpl: typeof fetch, overrides: Partial<BuiltinToolContext> = {}) {
  return { search, baseUrl: "https://gw.example.com", fetchImpl, ...overrides };
}

const manyResults = Array.from({ length: 14 }, (_, index) => ({
  title: `Result ${index}`,
  url: `https://example.org/${index}`,
  content: `Snippet ${index}`,
}));

describe("web_search", () => {
  it("returns the top five results with title, url and snippet", async () => {
    const seen: URL[] = [];
    const result = await runBuiltinTool(
      "web_search",
      { query: "red panda" },
      context(jsonFetch({ results: manyResults }, 200, seen)),
    );
    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.text) as { results: Record<string, string>[] };
    expect(parsed.results).toHaveLength(5);
    expect(parsed.results[0]).toEqual({
      title: "Result 0",
      url: "https://example.org/0",
      snippet: "Snippet 0",
    });
    const url = seen[0];
    expect(url.pathname).toBe("/search");
    expect(url.searchParams.get("q")).toBe("red panda");
    expect(url.searchParams.get("format")).toBe("json");
    expect(url.searchParams.get("categories")).toBe("general");
    expect(url.searchParams.get("safesearch")).toBe("1");
  });

  it("allows up to ten results and rejects more", async () => {
    const ok = await runBuiltinTool(
      "web_search",
      { query: "x", max_results: 10 },
      context(jsonFetch({ results: manyResults })),
    );
    expect((JSON.parse(ok.text) as { results: unknown[] }).results).toHaveLength(10);
    const tooMany = await runBuiltinTool(
      "web_search",
      { query: "x", max_results: 11 },
      context(jsonFetch({ results: manyResults })),
    );
    expect(tooMany.isError).toBe(true);
    expect(tooMany.text).toMatch(/^Error: invalid arguments \(max_results/);
  });

  it("uses the deployment safe search, never one from the model", async () => {
    const seen: URL[] = [];
    await runBuiltinTool(
      "web_search",
      { query: "x", safesearch: 0 },
      context(jsonFetch({ results: [] }, 200, seen), { search: { ...search, safesearch: 2 } }),
    );
    expect(seen[0].searchParams.get("safesearch")).toBe("2");
  });

  it("drops duplicates and non-http urls and reports an empty result", async () => {
    const result = await runBuiltinTool(
      "web_search",
      { query: "x" },
      context(
        jsonFetch({
          results: [
            { title: "A", url: "https://a.example/" },
            { title: "A again", url: "https://a.example/" },
            { title: "ftp", url: "ftp://a.example/file" },
            { title: "none" },
          ],
        }),
      ),
    );
    expect((JSON.parse(result.text) as { results: unknown[] }).results).toHaveLength(1);
    const empty = await runBuiltinTool(
      "web_search",
      { query: "x" },
      context(jsonFetch({ results: [] })),
    );
    expect(empty).toEqual({ text: "No results found.", isError: false });
  });

  it("turns backend failures into readable errors without the query", async () => {
    const failed = await runBuiltinTool(
      "web_search",
      { query: "secret query" },
      context(jsonFetch({}, 502)),
    );
    expect(failed).toEqual({
      text: "Error: The search backend failed (HTTP 502).",
      isError: true,
    });
    const forbidden = await runBuiltinTool(
      "web_search",
      { query: "x" },
      context(jsonFetch({}, 403)),
    );
    expect(forbidden.text).toContain("search.formats");
    const unreachable = await runBuiltinTool(
      "web_search",
      { query: "x" },
      context((async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch),
    );
    expect(unreachable.text).toBe("Error: The search backend is unreachable.");
  });

  it("is unavailable without SEARXNG_URL", async () => {
    const result = await runBuiltinTool(
      "web_search",
      { query: "x" },
      context(jsonFetch({}), { search: undefined }),
    );
    expect(result).toEqual({
      text: "Error: web search is not configured (set SEARXNG_URL)",
      isError: true,
    });
  });

  it("clips long text at a word boundary", () => {
    expect(clip("  one   two  ", 100)).toBe("one two");
    expect(clip("alpha beta gamma delta", 12)).toBe("alpha beta…");
  });

  it("aborts a slow backend", async () => {
    const never = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as typeof fetch;
    await expect(
      searchSearxng({
        baseUrl: search.url,
        query: "x",
        category: "general",
        safesearch: 1,
        fetchImpl: never,
        timeoutMs: 20,
      }),
    ).rejects.toThrow("did not answer in time");
  });
});

describe("built-in tool registry", () => {
  it("lists tools with their availability", () => {
    expect(listBuiltinTools(null)).toEqual([
      expect.objectContaining({
        name: "web_search",
        available: false,
        unavailable_reason: "web search is not configured (set SEARXNG_URL)",
      }),
    ]);
    expect(listBuiltinTools(search)[0]).toMatchObject({ name: "web_search", available: true });
  });

  it("keeps only known, runnable selections", () => {
    expect(availableBuiltinTools(["web_search", "nope"], search)).toEqual(["web_search"]);
    expect(availableBuiltinTools(["web_search"], null)).toEqual([]);
  });
});

describe("gateway tools", () => {
  const ctx: BuiltinToolContext = { search, baseUrl: "https://gw.example.com" };

  it("adds built-in tools after MCP tools and only with a context", () => {
    const route = { mcpTools: [], builtinTools: ["web_search" as const] };
    expect(routeGatewayTools(route)).toEqual([]);
    const tools = routeGatewayTools(route, ctx);
    expect(tools.map((tool) => [tool.exposedName, tool.source])).toEqual([
      ["web_search", "builtin"],
    ]);
    expect(routeHasGatewayTools(route)).toBe(true);
    expect(routeHasGatewayTools({ mcpTools: [], builtinTools: [] })).toBe(false);
  });

  it("offers the built-in schema to the model", () => {
    const merged = mergeMcpTools(
      [{ type: "function", function: { name: "show_image" } }],
      routeGatewayTools({ mcpTools: [], builtinTools: ["web_search"] }, ctx),
    ) as { function: { name: string; parameters: { required?: string[] } } }[];
    expect(merged.map((tool) => tool.function.name)).toEqual(["show_image", "web_search"]);
    expect(merged[1].function.parameters.required).toEqual(["query"]);
  });

  it("reads client tool names from chat and responses shapes", () => {
    expect([
      ...clientToolNames([
        { type: "function", function: { name: "show_image" } },
        { type: "function", name: "web_search" },
        "junk",
      ]),
    ]).toEqual(["show_image", "web_search"]);
  });
});
