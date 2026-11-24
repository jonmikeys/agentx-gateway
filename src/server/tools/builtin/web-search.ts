import { z } from "zod";
import { isHttpUrl, searchSearxng, uniqueBy } from "@/server/search/searxng";
import { type BuiltinTool, needsSearch } from "@/server/tools/builtin/types";

export const WEB_SEARCH_DEFAULT_RESULTS = 5;
export const WEB_SEARCH_MAX_RESULTS = 10;
const SNIPPET_MAX_CHARS = 400;

const argsSchema = z.object({
  query: z.string().trim().min(1, "query is required").max(400),
  max_results: z.coerce
    .number()
    .int()
    .min(1)
    .max(WEB_SEARCH_MAX_RESULTS)
    .default(WEB_SEARCH_DEFAULT_RESULTS),
});

export type WebSearchArgs = z.infer<typeof argsSchema>;

/** Collapses whitespace and cuts long text at a word boundary. */
export function clip(text: string | undefined, max: number): string {
  const clean = (text ?? "").replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export const webSearchTool: BuiltinTool<WebSearchArgs> = {
  name: "web_search",
  description:
    "Search the web. Returns the top results with title, url and snippet. Use read_web_page " +
    "to read a result in full.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "What to search for." },
      max_results: {
        type: "integer",
        minimum: 1,
        maximum: WEB_SEARCH_MAX_RESULTS,
        description: `How many results to return (default ${WEB_SEARCH_DEFAULT_RESULTS}).`,
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
  args: argsSchema,
  availability: needsSearch,
  async execute(args, context) {
    if (!context.search) throw new Error("web search is not configured");
    const raw = await searchSearxng({
      baseUrl: context.search.url,
      query: args.query,
      category: "general",
      safesearch: context.search.safesearch,
      signal: context.signal,
      fetchImpl: context.fetchImpl,
    });
    const results = uniqueBy(
      raw.filter((result) => isHttpUrl(result.url)),
      (result) => result.url,
    )
      .slice(0, args.max_results)
      .map((result) => ({
        title: clip(result.title, 200) || (result.url as string),
        url: result.url as string,
        snippet: clip(result.content, SNIPPET_MAX_CHARS),
      }));
    if (results.length === 0) return { text: "No results found.", isError: false };
    return { text: JSON.stringify({ results }), isError: false };
  },
};
