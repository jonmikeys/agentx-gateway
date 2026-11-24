import { z } from "zod";
import { isHttpUrl, type SearxngResult, searchSearxng, uniqueBy } from "@/server/search/searxng";
import {
  createWebMediaItems,
  describeWebMedia,
  type NewWebMedia,
  toWebMediaEntry,
} from "@/server/services/web-media";
import {
  type BuiltinTool,
  type BuiltinToolContext,
  type BuiltinToolResult,
  needsSearch,
} from "@/server/tools/builtin/types";
import { clip } from "@/server/tools/builtin/web-search";

export const MEDIA_SEARCH_DEFAULT_RESULTS = 5;
export const MEDIA_SEARCH_MAX_RESULTS = 10;

export const mediaSearchArgsSchema = z.object({
  query: z.string().trim().min(1, "query is required").max(400),
  max_results: z.coerce
    .number()
    .int()
    .min(1)
    .max(MEDIA_SEARCH_MAX_RESULTS)
    .default(MEDIA_SEARCH_DEFAULT_RESULTS),
});

export type MediaSearchArgs = z.infer<typeof mediaSearchArgsSchema>;

export function mediaSearchParameters(noun: string): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      query: { type: "string", description: `What ${noun} to search for.` },
      max_results: {
        type: "integer",
        minimum: 1,
        maximum: MEDIA_SEARCH_MAX_RESULTS,
        description: `How many results to return (default ${MEDIA_SEARCH_DEFAULT_RESULTS}).`,
      },
    },
    required: ["query"],
    additionalProperties: false,
  };
}

/** A SearXNG image result as a temporary item, or undefined when it has no usable image URL. */
export function imageFromResult(result: SearxngResult): NewWebMedia | undefined {
  if (!isHttpUrl(result.img_src)) return undefined;
  return {
    kind: "image",
    title: clip(result.title, 200),
    sourcePageUrl: isHttpUrl(result.url) ? result.url : undefined,
    mediaUrl: result.img_src,
    thumbnailUrl: isHttpUrl(result.thumbnail_src) ? result.thumbnail_src : undefined,
    resolution: typeof result.resolution === "string" ? clip(result.resolution, 40) : undefined,
  };
}

/**
 * Searches one SearXNG category, stores the usable results as temporary media items for the
 * session, and returns them with their ids. The ids work wherever a media catalogue id does
 * (`GET /v1/media/{id}`, the client's `show_image` / `show_video`).
 */
export async function runMediaSearch(
  category: "images" | "videos",
  toItem: (result: SearxngResult) => NewWebMedia | undefined,
  args: MediaSearchArgs,
  context: BuiltinToolContext,
): Promise<BuiltinToolResult> {
  if (!context.search) throw new Error("web search is not configured");
  if (!context.sessionId || !context.apiKeyId) {
    throw new Error("media search needs a client session");
  }
  const raw = await searchSearxng({
    baseUrl: context.search.url,
    query: args.query,
    category,
    safesearch: context.search.safesearch,
    signal: context.signal,
    fetchImpl: context.fetchImpl,
  });
  const items = uniqueBy(
    raw.map(toItem).filter((item): item is NewWebMedia => item !== undefined),
    (item) => item.mediaUrl,
  ).slice(0, args.max_results);
  if (items.length === 0) return { text: "No results found.", isError: false };
  const rows = await createWebMediaItems(context.sessionId, context.apiKeyId, items);
  const results = rows.map((row) => ({
    media_id: row.id,
    title: toWebMediaEntry(row, context.baseUrl).name,
    description: describeWebMedia(row),
    source_page: row.sourcePageUrl,
    ...(row.resolution ? { resolution: row.resolution } : {}),
    ...(row.durationSeconds !== null ? { duration_seconds: row.durationSeconds } : {}),
  }));
  return { text: JSON.stringify({ results }), isError: false };
}

export const imageSearchTool: BuiltinTool<MediaSearchArgs> = {
  name: "image_search",
  description:
    "Search the web for images. Each result has a media_id you can show like a media library " +
    "item (for example with show_image). The ids last for this conversation only.",
  parameters: mediaSearchParameters("images"),
  args: mediaSearchArgsSchema,
  availability: needsSearch,
  execute: (args, context) => runMediaSearch("images", imageFromResult, args, context),
};
